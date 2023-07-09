
import requests
import yfinance as yf
from GoogleNews import GoogleNews
import json
import datetime
import time
import os
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor
import hashlib
import sys
import logging
import argparse
from Levenshtein import distance as levenshtein_distance
from bs4 import BeautifulSoup
import requests
import feedparser




load_dotenv("../config/.env")

STOCKNEWS_API_KEY = os.getenv("STOCKNEWS_API_KEY")


logging.basicConfig(
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y/%m/%d %H:%M:%S',
    stream=sys.stderr 
)

logging.getLogger().setLevel(logging.INFO)



# Debugging tool to print curl commands from Python requests
def print_curl_command(request):
    command = "curl '{uri}' -X {method} -H {headers} {data}"
    method = request.method
    uri = request.url
    data = "-d '{0}'".format(request.body) if request.body else ""
    headers = ['"{0}: {1}"'.format(k, v) for k, v in request.headers.items()]
    headers = " -H ".join(headers)
    logging.info(command.format(uri=uri, method=method, headers=headers, data=data))
# To use:   
# print_curl_command(response.request)

def generate_id(title, date):
    """Generate a unique ID based on the title and date of the news article."""
    return hashlib.sha256((title + str(date)).encode()).hexdigest()


# # TickerTick API
# Rate limit:
# All endpoints have a rate limit of 10 requests per minute from the same IP address. The service enforces this. More precisely, an IP will be blocked for one minute if more than 10 requests are sent within any 1 minute time window.

def fetch_tickertick_news(ticker='AAPL', period=1, proxies=None):
    try:
        logging.info("Fetching data from TickerTick API...")
        base_url = 'https://api.tickertick.com/feed'
        query = f'(diff (and tt:{ticker}) (or s:reddit s:phonearena s:slashgear)) (or T:fin_news T:analysis T:industry T:earning T:curated)'
        params = f'?q={query}&n=50'
        url = base_url + params
        last_id = None
        tickertick_news = []

        for i in range(len(proxies)):
            try:
                if last_id:
                    url = base_url + params + f'&last={last_id}'
                proxy = proxies[i]
                logging.info(f"Using proxy {proxy} for TickerTick API...")
                response = requests.get(url, proxies={"http": proxy, "https": proxy})
                tickertick_news_raw = response.json()['stories']
                tickertick_news_raw = [n for n in tickertick_news_raw if n['title'].strip()]
                
                if not tickertick_news_raw:
                    logging.info(f"No results from TickerTick API with proxy {proxy}. Possibly a 429 status code. Switching proxy...")
                    continue

                for news in tickertick_news_raw:
                    news_date = datetime.datetime.fromtimestamp(news.get('time') / 1000)
                    if (datetime.datetime.now() - news_date).days > period:
                        logging.info("Data fetched successfully from TickerTick API.")
                        return tickertick_news
                    
                    tickertick_news.append({
                        'Id': generate_id(news.get('title'), news_date),
                        'News headline': news.get('title'),
                        'Date': news_date,
                        'Ticker': news.get('tickers')[0].upper(),
                        'Stock name': news.get('tickers')[0].upper(),
                        'Source': 'tickertick_news'
                    })
                last_id = tickertick_news_raw[-1]['id']
                logging.info(f"Fetching next 100 articles. Last ID: {last_id}")
            except Exception as e:
                logging.info(f"An error occurred while fetching data from TickerTick API with proxy {proxy}: {e}")
                logging.info("Retrying with a different proxy...")
    except Exception as e:
        logging.info(f"An error occurred while fetching data from TickerTick API: {e}")
        return []
    return []




# # Google News 
# https://newscatcherapi.com/blog/google-news-rss-search-parameters-the-missing-documentaiton

class DateTimeEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, datetime.datetime):
            return o.isoformat()
        return super(DateTimeEncoder, self).default(o)
  
def fetch_google_news(ticker='AAPL', period=1, proxies=None):
    try:
        logging.info("Fetching data from Google News RSS feed...")

        # Process the results
        google_news = []

        for i in range(len(proxies)):
            proxy = proxies[i]
            logging.info(f"Using proxy {proxy} for Google News...")
            # Set the proxy environment variables
            os.environ['http_proxy'] = proxy
            os.environ['https_proxy'] = proxy

            try:
                # Create a GoogleNews object with the current date as the start and end date
                url = f"https://news.google.com/rss/headlines/section/topic/BUSINESS?q={ticker}%20stock%20when%3A{period}d&hl=en-US&gl=US&ceid=US%3Aen&num=50"
                response = requests.get(url, proxies={"http": proxy, "https": proxy}, timeout=10)
                feed = feedparser.parse(response.text)

                for entry in feed.entries:
                    title = entry.title
                    # Skip the entry if the title contains "... -"
                    if "... -" in title:
                        continue
                    date = datetime.datetime.strptime(entry.published, '%a, %d %b %Y %H:%M:%S %Z')  # Parse the date
                    google_news.append({
                        'Id': generate_id(title, date),
                        'News headline': title,
                        'Date': date,
                        'Ticker': ticker,
                        'Stock name': ticker,
                        'Source': 'google_news'
                    })

                logging.info("Data fetched successfully from Google News.")
                return google_news

            except Exception as e:
                logging.error(f"An error occurred while fetching data from Google News with proxy {proxy}: {e}")
                logging.info("Retrying with a different proxy...")

        logging.error("All proxies failed for Google News. No data was fetched.")
        return []

    except Exception as e:
        logging.error(f"An error occurred while fetching data from Google News : {e}")
        return []





# # Process the data

# def remove_duplicates(news_list):
#     """Remove duplicates from the list of news articles."""
#     news_dict = {generate_id(news['title'], news['date']): news for news in news_list}
#     return list(news_dict.values())


def calculate_similarity(string1, string2):
    """Calculate the similarity between two strings using the OSA distance."""
    # Calculate the Levenshtein distance
    distance = levenshtein_distance(string1, string2)
    # Calculate the maximum possible distance
    max_distance = max(len(string1), len(string2))
    # Calculate the similarity
    similarity = 1 - distance / max_distance
    return similarity

def remove_similar_headlines(news_list, similarity_threshold=0.6):
    logging.info("Removing similar headlines...")
    """Remove headlines with a similarity greater than the specified threshold."""
    # Initialize an empty list to store the unique news
    unique_news = []
    # Initialize a counter for the number of removed headlines
    removed_headlines = 0
    # Loop over the news in the list
    for news in news_list:
        # Assume that the news is unique until proven otherwise
        is_unique = True
        # Loop over the unique news
        for unique in unique_news:
            # If the news is for the same company on the same day
            if news['Ticker'] == unique['Ticker'] and news['Date'].date() == unique['Date'].date():
                # Calculate the similarity between the headlines
                similarity = calculate_similarity(news['News headline'], unique['News headline'])
                # If the similarity is greater than the threshold
                if similarity > similarity_threshold:
                    # The news is not unique
                    is_unique = False
                    # logging.info(f"Removing duplicate headline: {news['title']}")
                    # logging.info(f"Similarity with headline: {unique['title']}")
                    removed_headlines += 1
                    break
        # If the news is unique
        if is_unique:
            # Add it to the list of unique news
            unique_news.append(news)
    logging.info(f"Total similar headlines removed: {removed_headlines}")
    return unique_news


def print_news_headlines(tickertick_news, google_news):
    try:
        logging.info("Printing news headlines...")


        for n in tickertick_news:
            logging.info("TickerTick",  n['News headline'])
        for n in google_news:
            logging.info("Google",  n['News headline'])
        logging.info("News headlines printed successfully.")
    except Exception as e:
        logging.error(f"An error occurred while printing news headlines: {e}")

def main(ticker='AAPL', period=1):
    with ThreadPoolExecutor() as executor:
        try:
            tickertick_news_future = executor.submit(fetch_tickertick_news, ticker, period)
            google_news_future = executor.submit(fetch_google_news, ticker, period)

            # Get the results from the futures
            tickertick_news = tickertick_news_future.result()
            google_news = google_news_future.result()

        except Exception as e:
            logging.error(f"An error occurred while fetching data: {e}", file=sys.stderr)
            tickertick_news = []
            google_news = []

    # Combine the news from both sources into a single list
    news_data = tickertick_news + google_news

    # Remove similar headlines
    news_data = remove_similar_headlines(news_data)
    
    return news_data


if __name__ == '__main__':
    # Load the tickers from the stocks.json file
    with open('stocks.json', 'r') as file:
        data = json.load(file)
        tickers = data['stocks']

    # Load the proxies from the proxies file
    with open('../scripts/proxy/workingproxies.txt', 'r') as f:
        proxies = f.read().splitlines()

    all_news_data = []

    # Fetch news for each ticker
    for i, ticker in enumerate(tickers):
        print(f"Fetching news for {ticker}...")
        proxies = proxies[i:] + proxies[:i]  # Rotate the proxies list
        with ThreadPoolExecutor() as executor:
            try:
                tickertick_news_future = executor.submit(fetch_tickertick_news, ticker, 1, proxies)
                google_news_future = executor.submit(fetch_google_news, ticker, 1, proxies)

                # Get the results from the futures
                tickertick_news = tickertick_news_future.result()
                google_news = google_news_future.result()

            except Exception as e:
                logging.error(f"An error occurred while fetching data: {e}", file=sys.stderr)
                tickertick_news = []
                google_news = []

        # Combine the news from both sources into a single list
        news_data = tickertick_news + google_news

        # Remove similar headlines
        news_data = remove_similar_headlines(news_data)

        all_news_data.extend(news_data)


    # Remove duplicates from all_news_data
    all_news_data = list({news['Id']: news for news in all_news_data}.values())

    try:
        json_output = json.dumps(all_news_data, cls=DateTimeEncoder, ensure_ascii=False, indent=4)
        
        # Save the JSON output to the data folder
        file_path = os.path.join('..', 'data', 'newsData.json')
        with open(file_path, 'w') as file:
            file.write(json_output)
            
        print("JSON output saved successfully.")
    except Exception as e:
        print(f"Error generating JSON or saving the output: {e}")