import os
import json
import anthropic
import datetime
from dotenv import load_dotenv
import argparse
import logging
import sys


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



class SentimentAnalyzer:
    def __init__(self, api_key):
        self.claude = anthropic.Client(api_key=api_key)

    def analyze_sentiment(self, headline):
        prompt_base = """Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain in the first line. Then elaborate with one short and concise sentence on the next line. """
        prompt = f'{anthropic.HUMAN_PROMPT}{prompt_base} {headline} {anthropic.AI_PROMPT}'
        try:
            response = self.claude.completion(
                prompt=prompt,
                stop_sequences=[anthropic.HUMAN_PROMPT],
                model='claude-v1',
                max_tokens_to_sample=100,
                temperature=0
            )
            sentiment = response['completion']
            return sentiment
        except Exception as e:
            logging.info(f"Error during sentiment analysis: {e}")
            return None

    def process_news(self, news):
        """Process a list of news articles."""
        results = []
        for article in news:
            headline = article.get('News headline')
            stock_name = article.get('Stock name')
            ticker = article.get('Ticker')
            if headline is not None and stock_name is not None and ticker is not None:
                sentiment = self.analyze_sentiment(headline)
                if sentiment is not None:
                    sentiment, description = sentiment.split('\n')
                    article['Sentiment'] = sentiment.strip()
                    article['Description'] = description
                    results.append(article)
        return results

import datetime

def calculate_sentiment_score(path, output_path):
    """Load the JSON data, calculate the sentiment score for each stock, and save the results."""
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        logging.info(f"Error loading JSON: {e}")
        return

    stock_counts = {}
    positive_counts = {}
    for entry in data:
        stock_name = entry.get('Stock name')
        ticker = entry.get('Ticker')
        sentiment = entry.get('Sentiment')

        if stock_name is not None and ticker is not None and sentiment is not None:
            # Increment the count for this stock
            stock_counts[(stock_name, ticker)] = stock_counts.get((stock_name, ticker), 0) + 1
            # If the sentiment is positive, increment the positive count
            if sentiment.lower() == 'yes':
                positive_counts[(stock_name, ticker)] = positive_counts.get((stock_name, ticker), 0) + 1

    # Calculate the sentiment scores and save the results
    results = []
    for (stock_name, ticker), positive_count in positive_counts.items():
        total_count = stock_counts[(stock_name, ticker)]
        score = (positive_count / total_count) * 100  # score as a percentage
        result = {
            "ID": len(results) + 1,
            "DATE": datetime.datetime.now().isoformat(),
            "Stock Name": stock_name,
            "Ticker": ticker,
            "Score": round(score, 2)
        }
        results.append(result)

    save_json(output_path, results)


def load_json(path):
    """Load a JSON file."""
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        logging.info(f"Error loading JSON: {e}")
        return None


def save_json(path, data):
    """Save data to a JSON file."""
    try:
        with open(path, 'w') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        logging.info(f"Error saving JSON: {e}")

def main():
    print("Starting sentiment analysis...")
    parser = argparse.ArgumentParser(description='Analyze sentiment of news articles.')
    parser.add_argument('input', help='The JSON file to load news articles from.')
    parser.add_argument('output', help='The JSON file to save results to.')
    parser.add_argument('output2', help='The JSON file to save results to.')
    args = parser.parse_args()

    analyzer = SentimentAnalyzer(anthropic_key)
    print("SentimentAnalyzer initialized.")

    news = load_json(args.input)
    if news is not None:
        print("News data loaded successfully.")
        print("Starting sentiment analysis")
        results = analyzer.process_news(news)
        print("Sentiment analysis completed.")
        save_json(args.output, results)
        print("Sentiment analysis results saved.")
        print("Starting sentiment score calculation")
        calculate_sentiment_score(args.output, args.output2)
        print("Sentiment scores calculated and saved.")
    else:
        print("Failed to load news data.")

    print("Sentiment analysis process finished.")

if __name__ == "__main__":
    main()


