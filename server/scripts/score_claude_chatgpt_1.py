import os
import json
import argparse
import openai
import anthropic
from datetime import datetime
import re

class BaseSentimentAnalyzer:
    def process_news(self, news):
        results = []
        for article in news:
            headline = article.get('News headline')
            stock_name = article.get('Stock name')
            ticker = article.get('Ticker')

            if all([headline, stock_name, ticker]):
                content = self.analyze_sentiment(headline)
                sentiment, description = self.extract_sentiment_description(content)

                if sentiment:
                    article['Sentiment'] = sentiment.strip()
                if description:
                    article['Description'] = description.strip()
                results.append(article)
        return results

    def process_json(self, news):
        results= "".join(f'{article.get("Ticker")}|{article.get("News headline")}\n' for article in news if article.get('News headline') and article.get('Ticker'))
        return results




class OpenAISentimentAnalyzer(BaseSentimentAnalyzer):
    def __init__(self, api_key):
        openai.api_key = api_key

    @staticmethod
    def extract_sentiment_description(content):
        match = re.search(r'\b(YES|NO|UNKNOWN)\b\s*([\s\S]+)', content)
        if match:
            sentiment = match.group(1)
            description = match.group(2).strip()
            return sentiment, description
        else:
            print("Este contenido No hizo Match en chatgpt:", content)
            return None, None

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
                print("RateLimitError: That model is currently overloaded with other requests. Retrying in 10 seconds.")
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
        print(anthropic.HUMAN_PROMPT)
        print({anthropic.AI_PROMPT})
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
    parser.add_argument('assistant', choices=['chatgpt', 'claude'], help='The assistant to use for sentiment analysis.')
    parser.add_argument('input', help='The JSON file to load news articles from.')
    parser.add_argument('output', help='The JSON file to save results to.')
    args = parser.parse_args()

    if args.assistant == 'chatgpt':
        api_key = os.environ['OPENAI_API_KEY']
        analyzer = OpenAISentimentAnalyzer(api_key)
    else:
        api_key = os.environ['ANTHROPIC_API_KEY']
        analyzer = ClaudeSentimentAnalyzer(api_key)

    news = load_json(args.input)
    if news:
        results = analyzer.process_json(news)
        sentiment_results = analyzer.analyze_sentiment(results)
        calculate_score_bulk(args.output, sentiment_results)
    else:
        print("Error: Failed to load news data.")

if __name__ == "__main__":
    main()
