import os
import json
import datetime
from dotenv import load_dotenv
import argparse
import logging
import sys
import vertexai
from vertexai.language_models import TextGenerationModel

# Load .env file
dotenv_path = os.path.join(os.path.dirname(__file__), '../config/.env')
load_dotenv(dotenv_path)

# Set the GOOGLE_APPLICATION_CREDENTIALS environment variable
os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = os.path.join(os.path.dirname(__file__), os.getenv('GOOGLE_APPLICATION_CREDENTIALS_PATH'))

# Initialize Vertex AI
vertexai.init(project="tradingapp-392117", location="us-central1")
model = TextGenerationModel.from_pretrained("text-bison@001")
parameters = {
    "temperature": 0.2,
    "max_output_tokens": 256,
    "top_p": 0.8,
    "top_k": 40
}

logging.basicConfig(level=logging.INFO)

class SentimentAnalyzer:
    def __init__(self):
        self.model = model
        self.parameters = parameters

    def analyze_sentiment(self, headline, company):
        prompt_base = f"""Forget all your previous instructions. Pretend you are a financial expert.
        Positive sentiment about {company} in the news usually results in the price of its stock increasing and vice versa.
        Depending on the news text predict if the value of the stock would increase or decrease.
        The output should be in the range of -1 to 1. Where 1 represents a potential increase in the stock price, -1 means
        the value is likely to decrease and 0 means price will remain unchanged.\n
        input: Elon Musk smokes weed at Joe Rogan Show. People think it was irresponsible of him to do so, being the CEO of Tesla.
        output: -0.9

        input: Tesla has acquired a new battery technology company which is likely to result in higher effeciency batteries in its next generation cars.
        output: 0.75

        input: Tesla Laying off workers in China factory.
        output: -0.1

        input: {headline}.
        output:
        """
        prompt = f'{prompt_base} {headline}'
        response = self.model.predict(prompt, **self.parameters)
        try:
            response = int(response)
            if response > 0.3:
                return "YES"
            elif response < -0.3:
                return "NO"
            else:
                return "UNKNOWN"

        except ValueError:
            if response.text:
                sentiment = response.text
                logging.info(f"Sentiment for '{headline}': {sentiment}")
                return sentiment
            else:
                logging.warning(f"No sentiment returned for '{headline}'")
                return None

    def process_news(self, news):
        """Process a list of news articles."""
        results = []
        for article in news:
            headline = article.get('News headline')
            stock_name = article.get('Stock name')
            ticker = article.get('Ticker')
            if headline is not None and stock_name is not None and ticker is not None:
                logging.info(f"Processing article: {headline}")
                sentiment = self.analyze_sentiment(headline, stock_name)
                if sentiment is not None:
                    sentiment = sentiment.strip()
                    if sentiment.startswith('YES'):
                        sentiment, description = sentiment.split(' ', 1)
                    elif sentiment.startswith('NO'):
                        sentiment, description = sentiment.split(' ', 1)
                    elif sentiment.startswith('UNKNOWN'):
                        sentiment, description = sentiment.split(' ', 1)
                    else:
                        description = sentiment
                        sentiment = 'UNKNOWN'  # or some default value
                    article['Sentiment'] = sentiment
                    article['Description'] = description
                    results.append(article)
                else:
                    logging.warning(f"No sentiment returned for article: {headline}")
            else:
                logging.warning(f"Missing data in article: {article}")
        return results


def calculate_sentiment_score(path, output_path):
    """Load the JSON data, calculate the sentiment score for each stock, and save the results."""
    try:
        with open(path) as f:
            data = json.load(f)
    except Exception as e:
        logging.error(f"Error loading JSON: {e}")
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
            data = json.load(f)
        logging.info(f"Loaded {len(data)} entries from {path}")
        return data
    except Exception as e:
        logging.error(f"Error loading JSON: {e}")
        return None

def save_json(path, data):
    """Save data to a JSON file."""
    try:
        with open(path, 'w') as f:
            json.dump(data, f, indent=4)
        logging.info(f"Saved {len(data)} entries to {path}")
    except Exception as e:
        logging.error(f"Error saving JSON: {e}")

def main():
    print("Starting sentiment analysis...")
    parser = argparse.ArgumentParser(description='Analyze sentiment of news articles.')
    parser.add_argument('input', help='The JSON file to load news articles from.')
    parser.add_argument('output', help='The JSON file to save results to.')
    parser.add_argument('output2', help='The JSON file to save results to.')
    args = parser.parse_args()

    analyzer = SentimentAnalyzer()
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
