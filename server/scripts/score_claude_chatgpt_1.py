import os
import json
import argparse
import openai
import anthropic
from datetime import datetime
import re
import logging
import sys
import time
from dotenv import load_dotenv

# Load .env file
dotenv_path = os.path.join(os.path.dirname(__file__), '../config/.env')
load_dotenv(dotenv_path)

# Now you can access your keys with os.getenv
openai_key = os.getenv('OPENAI_API_KEY')
anthropic_key = os.getenv('ANTHROPIC_API_KEY')




logging.basicConfig(
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y/%m/%d %H:%M:%S',
    stream=sys.stderr 
)

logging.getLogger().setLevel(logging.INFO)


class BaseSentimentAnalyzer:


    def process_json(self, news):
        results= "".join(f'{article.get("Ticker")}|{article.get("News headline")}\n' for article in news if article.get('News headline') and article.get('Ticker'))
        return results




class OpenAISentimentAnalyzer(BaseSentimentAnalyzer):
    def __init__(self, api_key):
        openai.api_key = api_key



    def analyze_sentiment(self, text):
        prompt="""Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain , Only respond with the line in the format Ticker|(YES, NO, or UNKNWON):  """
        MODEL = "gpt-3.5-turbo"

        retries = 0
        while retries < 5:
            try:
                response = openai.ChatCompletion.create(
                    model=MODEL,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": text},
                    ],
                    temperature=0,
                )
                break
            except openai.error.RateLimitError:
                logging.info("RateLimitError: That model is currently overloaded with other requests. Retrying in 10 seconds.")
                time.sleep(10)
                retries += 1

        if retries == 5:
            raise Exception("Failed to get response from OpenAI after 5 retries.")

        sentiment = response['choices'][0]['message']['content']
        return sentiment


class ClaudeSentimentAnalyzer(BaseSentimentAnalyzer):
    def __init__(self, api_key):
        self.claude = anthropic.Client(api_key=api_key)
    



    def _prompt_builder(self, headline):
        prompt_base = """Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain , Only respond with the line in the format Ticker|(YES, NO, or UNKNWON): """
        logging.info(anthropic.HUMAN_PROMPT)
        logging.info({anthropic.AI_PROMPT})
        return f'{anthropic.HUMAN_PROMPT}{prompt_base} {headline} {anthropic.AI_PROMPT}'

    def analyze_sentiment(self, headline):
        prompt = self._prompt_builder(headline)
        try:
            response = self.claude.completion(
                prompt=prompt,
                stop_sequences=[anthropic.HUMAN_PROMPT],
                model='claude-v1.3-100k',
                max_tokens_to_sample=10000,
                temperature=0
            )
            sentiment = response['completion']
            return sentiment
        except Exception as e:
            print(f"Error during sentiment analysis: {e}")
            return None

    def analyze_sentiment_stream(self, headline):
        prompt = self._prompt_builder(headline)
        try:
            response_stream = self.claude.completion_stream(
                prompt=prompt,
                stop_sequences=[anthropic.HUMAN_PROMPT],
                model='claude-v1.3-100k',
                max_tokens_to_sample=100000,
                temperature=0,
                stream=True
            )
            for data in response_stream:
                print("Streaming Response:", data)
        except Exception as e:
            print(f"Error during sentiment analysis: {e}")
            return None



def calculate_score_bulk(output_path, data):
    ticker_sentiments = data.strip().split('\n')
    ticker_scores = {}

    for ticker_sentiment in ticker_sentiments:
        ticker, sentiment = ticker_sentiment.split('|')
        ticker_scores.setdefault(ticker, [0, 0])  # [total_yes, count]
        if sentiment == 'YES':
            ticker_scores[ticker][0] += 1
        ticker_scores[ticker][1] += 1

    results = [{"ID": idx+1, "DATE": datetime.now().isoformat(), "Ticker": ticker, "Score": (total_yes / count) * 100} for idx, (ticker, (total_yes, count)) in enumerate(ticker_scores.items())]
    save_json(output_path, results)

    
def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"Error loading JSON: {e}")
        return None

def save_json(path, data):
    try:
        with open(path, 'w') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"Error saving JSON: {e}")

def main():
    parser = argparse.ArgumentParser(description='Analyze sentiment of news articles.')
    parser.add_argument('input', help='The JSON file to load news articles from.')
    parser.add_argument('output', help='The JSON file to save results to.')
    args = parser.parse_args()

    if args.assistant == 'chatgpt':
        api_key = openai_key 
        # logging.info(f"OPENAI_API_KEY:"+api_key)
        analyzer = OpenAISentimentAnalyzer(api_key)
    else:
        api_key = anthropic_key 
        # logging.info(f"ANTHROPIC_API_KEY:"+api_key)
        analyzer = ClaudeSentimentAnalyzer(api_key)

    news = load_json(args.input)
    if news:
        sentiment_results = analyzer.process_json(news)
        calculate_score_bulk(args.output, sentiment_results)
    else:
        print("Error: Failed to load news data.")

if __name__ == "__main__":
    main()


