import sys
import yfinance as yf
import datetime

def fetch_yahoo_news(ticker='AAPL'):
    try:
        stock = yf.Ticker(ticker)
        yahoo_news_raw = stock.news

     
        
        yahoo_news_raw  = [n for n in yahoo_news_raw  if n['title'].strip()]
        yahoo_news = []
        for news in yahoo_news_raw:
            yahoo_news.append({
                'id': news.get('uuid'),
                'title': news.get('title'),
                'date': datetime.datetime.fromtimestamp(news.get('providerPublishTime')),
                'category': None,
                'tickers': news.get('relatedTickers'),
                'sentiment': None,
                'source': 'yahoo_news'
            })
            
        # Print the title of each news item
        for n in yahoo_news:
            print("Yahoo",  n['title'])

        return yahoo_news  # Return the yahoo_news list
    
    except Exception as e:
        print(f"An error occurred while fetching data from Yahoo Finance : {e}")
        return []

if __name__ == "__main__":
    # Get the input string from the command line arguments
    input_string = sys.argv[1]

    # Call the fetch_yahoo_news function
    fetch_yahoo_news(input_string)
