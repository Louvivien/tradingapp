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




load_dotenv("../config/.env")

STOCKNEWS_API_KEY = os.getenv("STOCKNEWS_API_KEY")


# Before running this file you need to update the session cookies for degiro and IB
# IB: filter requests on "search" in the browser network tab copy the curl command and paste it in Postman
    # paste the header section from Postman
# degiro: filter requests on "news" in the browser network tab copy the curl command and paste it in Postman
    # paste the sessionId from Postman





# Debugging tool to print curl commands from Python requests
def print_curl_command(request):
    command = "curl '{uri}' -X {method} -H {headers} {data}"
    method = request.method
    uri = request.url
    data = "-d '{0}'".format(request.body) if request.body else ""
    headers = ['"{0}: {1}"'.format(k, v) for k, v in request.headers.items()]
    headers = " -H ".join(headers)
    print(command.format(uri=uri, method=method, headers=headers, data=data))
# To use:   
# print_curl_command(response.request)

def generate_id(title, date):
    """Generate a unique ID based on the title and date of the news article."""
    return hashlib.sha256((title + str(date)).encode()).hexdigest()

# # Degiro API
# Paste the code from Postman to get the updated session ID

def fetch_degiro_news(ticker='AAPL', period=1):
    try:
        print("Fetching data from Degiro API...")
        url = 'https://trader.degiro.nl/dgtbxdsservice/newsfeed/v2/news-by-company' 
        stock = yf.Ticker(ticker)
        isin = stock.isin
        headers = {
            # headers
        }
        params = {
            'isin': isin, 
            'limit': 10, 
            'offset': 0,
            'sessionId': 'D6BF5A1F5BD04C3A846517624505D4D0.prod_b_128_5',
            'languages': 'en,fr' 
        }

        degiro_news = []
        while True:
            response = requests.get(url, headers=headers, params=params)
            # print_curl_command(response.request)
            degiro_news_raw = response.json()['data']['items']
            degiro_news_raw = [n for n in degiro_news_raw  if n['title'].strip()]
            for news in degiro_news_raw:
                news_date = datetime.datetime.strptime(news.get('date'), "%Y-%m-%dT%H:%M:%SZ")
                if (datetime.datetime.now() - news_date).days > period:
                    print("Data fetched successfully from Degiro API.")
                    return degiro_news
                degiro_news.append({
                    'id': news.get('id') or generate_id(news.get('title'), news_date),
                    'title': news.get('title'),
                    'date': news_date,
                    'category': news.get('category'),
                    'tickers': news.get('isins'),
                    'sentiment': None,
                    'source': 'degiro_news'
                })
            params['offset'] += 10
            print(f"Fetching next 10 articles. Current offset: {params['offset']}")
    except Exception as e:
        print(f"Session ID expired. Please update it - {e}")
        return []


# # StockNews API 
# 100 calls per month for free
# https://stocknewsapi.com/documentation
def fetch_stocknews_news(ticker='AAPL', period=1):
    try:
        print("Fetching data from StockNews API...")
        url = 'https://stocknewsapi.com/api/v1/trending-headlines'
        page = 1
        params = {
            'tickers': ticker,
            'page': page, 
            'token': STOCKNEWS_API_KEY 
        }

        stocknews_news = []
        while True:
            response = requests.get(url, params=params)
            # print_curl_command(response.request)

            stocknews_news_raw = response.json()['data']
            stocknews_news_raw = [n for n in stocknews_news_raw if n['title'].strip()]
            for news in stocknews_news_raw:
                news_date = datetime.datetime.strptime(news.get('date'), "%a, %d %b %Y %H:%M:%S %z")
                if (datetime.datetime.now() - news_date).days > period:
                    print("Data fetched successfully from StockNews API.")
                    return stocknews_news
                stocknews_news.append({
                    'id': generate_id(news.get('title'), news_date),
                    'title': news.get('title'),
                    'date': news_date,
                    'category': None,
                    'tickers': news.get('tickers'),
                    'sentiment': news.get('sentiment'),
                    'source': 'stocknews_news'
                })
            page += 1
            params['page'] = page
            print(f"Fetching next page. Current page: {page}")
    except Exception as e:
        print(f"An error occurred while fetching data from StockNews API: {e}")
        return []

# # TickerTick API
#  30 requests per minute from the same IP address
def fetch_tickertick_news(ticker='AAPL', period=1):
    try:
        print("Fetching data from TickerTick API...")
        base_url = 'https://api.tickertick.com/feed'
        query = f'(diff (and tt:{ticker}) (or s:reddit s:phonearena s:slashgear)) (or T:fin_news T:analysis T:industry T:earning T:curated)'
        params = f'?q={query}&n=100'
        url = base_url + params
        last_id = None
        tickertick_news = []

        while True:
            if last_id:
                url = base_url + params + f'&last={last_id}'
            response = requests.get(url)
            # print_curl_command(response.request)

            tickertick_news_raw = response.json()['stories']
            tickertick_news_raw = [n for n in tickertick_news_raw if n['title'].strip()]
            if not tickertick_news_raw:
                break

            for news in tickertick_news_raw:
                news_date = datetime.datetime.fromtimestamp(news.get('time') / 1000)
                if (datetime.datetime.now() - news_date).days > period:
                    print("Data fetched successfully from TickerTick API.")
                    return tickertick_news
                tickertick_news.append({
                    'id': generate_id(news.get('title'), news_date),
                    'title': news.get('title'),
                    'date': news_date,
                    'category': None,
                    'tickers': news.get('tickers'),
                    'sentiment': None,
                    'source': 'tickertick_news'
                })
            last_id = tickertick_news_raw[-1]['id']
            print(f"Fetching next 100 articles. Last ID: {last_id}")
    except Exception as e:
        print(f"An error occurred while fetching data from TickerTick API: {e}")
        return []




  

# Interactive Brokers API
# Paste the code from Postman to get the updated cookie
def fetch_ib_news(ticker='AAPL', period=1):
    # Get the contract number from the ticker
    try:
        print("Fetching contract number from Interactive Brokers API...")
        url = "https://www.interactivebrokers.co.uk/portal.proxy/v1/portal/iserver/secdef/search"

        payload = f'{{"symbol":"{ticker}","pattern":true,"referrer":"onebar"}}'
        headers = {
        'authority': 'www.interactivebrokers.co.uk',
        'accept': '*/*',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
        'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; URL_PARAM="RL=1"; AKA_A2=A; IB_LANG=fr; ib_fb_px=1; _uetsid=35e35da0ff9911ed9380097bf408f5eb; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685526901.9.0.1685526904.0.0.0; XYZAB_AM.LOGIN=dbab9a2ad85acc4e2d12bb35dd4623183e76fadc; XYZAB=dbab9a2ad85acc4e2d12bb35dd4623183e76fadc; USERID=102719436; IS_MASTER=true; cp.eu=dc22998f8b649da65498327ca85c0171; ibcust=159b58be768cd729593ed7e57c0aedb8; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=libj73g8&sl=4&tt=8vy&rl=1"',
        'origin': 'https://www.interactivebrokers.co.uk',
        'pragma': 'no-cache',
        'referer': 'https://www.interactivebrokers.co.uk/portal/',
        'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
        'x-ccp-session-id': '6476cc71.00000023',
        'x-embedded-in': 'web',
        'x-request-id': '18',
        'x-service': 'AM.LOGIN',
        'x-session-id': 'ad0b0f10-9957-4017-d192-79b3798fb75c',
        'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
        'x-xyzab': 'dbab9a2ad85acc4e2d12bb35dd4623183e76fadc'
        }

        response = requests.request("POST", url, headers=headers, data=payload)
        # print_curl_command(response.request)

        ib_contracts = response.json()[0]['conid']
        print(f"Contract number for {ticker}: {ib_contracts}")

    except Exception as e:
        print(f"Cookies expired. Please update it -  {e}")
        return []

    # Get the news from the contract number
    try:
        print("Fetching news from Interactive Brokers API...")
        url = "https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&tzone="

        payload = f'{{"modKeywords":[],"categories":[],"contracts":["{ib_contracts}"],"content_type":[],"contract_filter_type":[]}}'
        headers = headers

        ib_news = []
        while True:
            response = requests.request("POST", url, headers=headers, data=payload)
            # print_curl_command(response.request)

            ib_news_raw = response.json()['results']
            ib_news_raw = [n for n in ib_news_raw if n['headLineContent'].strip()]
            if not ib_news_raw:
                break

            for news in ib_news_raw:
                news_date = datetime.datetime.fromtimestamp(news.get('time') / 1000)
                if (datetime.datetime.now() - news_date).days > period:
                    print("Data fetched successfully from Interactive Brokers API.")
                    return ib_news
                ib_news.append({
                    'id': generate_id(news.get('headLineContent'), news_date),
                    'title': news.get('headLineContent'),
                    'date': news_date,
                    'category': None,
                    'tickers': [news.get('main_conid')],
                    'sentiment': news.get('sentiment'),
                    'source': 'ib_news'
                })
            last_time = str(ib_news_raw[-1]['time'])
            last_newsId = ib_news_raw[-1]['newsId']
            url = f"https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&nav_anchor={last_time},{last_newsId}&tzone="
            print(f"Fetching next set of articles. Last time: {last_time}, Last newsId: {last_newsId}")
    except Exception as e:
        print(f"An error occurred while fetching data from Interactive Brokers API : {e}")
        return []




# # Google News 
class DateTimeEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, datetime.datetime):
            return o.isoformat()
        return super(DateTimeEncoder, self).default(o)

def fetch_google_news(ticker='AAPL', period=1):
    try:
        print("Fetching data from Google News...")

        # Get the current date and the date a week ago
        end_date = datetime.datetime.now()
        start_date = end_date - datetime.timedelta(days=period)
        formatted_start_date = start_date.strftime("%m/%d/%Y")
        formatted_end_date = end_date.strftime("%m/%d/%Y")

        print(f"Start date: {formatted_start_date}, End date: {formatted_end_date}")

        # Create a GoogleNews object with the current date as the start and end date
        google_news_raw = GoogleNews(start=formatted_start_date, end=formatted_end_date)

        # Search for news related to the ticker and the ticker stock
        google_news_raw.search(f'{ticker}')
        google_news_results = google_news_raw.result()
        google_news_raw.search(f'{ticker} stock')
        google_news_results += google_news_raw.result()

        print("Google News raw results:", google_news_results)

        # Process the results
        google_news = []
        for news in google_news_results:
            if news.get('title').strip():  # Exclude news with empty title
                google_news.append({
                    'id': generate_id(news.get('title'), news.get('datetime')),
                    'title': news.get('title'),
                    'date': news.get('datetime'),  # Use the date from the news article
                    'brief': None,
                    'category': None,
                    'tickers': None,
                    'sentiment': None,
                    'source': 'google_news_results_dict'
                })

        print("Data fetched successfully from Google News.")
        return google_news

    except Exception as e:
        print(f"An error occurred while fetching data from Google News : {e}")
        return []

def remove_duplicates(news_list):
    """Remove duplicates from the list of news articles."""
    news_dict = {generate_id(news['title'], news['date']): news for news in news_list}
    return list(news_dict.values())


# def print_news_headlines(degiro_news, stocknews_news, tickertick_news, yahoo_news, ib_news,  google_news):

def print_news_headlines(degiro_news, stocknews_news, tickertick_news, ib_news,  google_news):
    try:
        print("Printing news headlines...")

        # Debug
        # print("IB news:", ib_news)

        for n in degiro_news: 
            print("Degiro",  n['title'])
        for n in stocknews_news: 
            print("Stocknews",  n['title']) 
        for n in tickertick_news:
            print("TickerTick",  n['title'])
        # for n in yahoo_news:
        #     print("Yahoo",  n['title'])
        for n in ib_news:
            print("IB",  n['title'])   
        for n in google_news:
            print("Google",  n['title'])
        print("News headlines printed successfully.")
    except Exception as e:
        print(f"An error occurred while printing news headlines: {e}")


def main(ticker='AAPL', period=1):
    with ThreadPoolExecutor() as executor:
        degiro_news = executor.submit(fetch_degiro_news, ticker, period)
        stocknews_news = executor.submit(fetch_stocknews_news, ticker, period)
        tickertick_news = executor.submit(fetch_tickertick_news, ticker, period)
        ib_news = executor.submit(fetch_ib_news, ticker, period)
        google_news = executor.submit(fetch_google_news, ticker, period)

    print_news_headlines(degiro_news.result(), stocknews_news.result(), tickertick_news.result(), ib_news.result(), google_news.result())



if __name__ == "__main__":
    main('AAPL', 1)



# from stocksight import News  
# from googlenews import GoogleNews


# # Stocksight (not working currently)
# try:
#     print("Fetching data from Stocksight...")
#     news = News('AAPL')
#     print("Data fetched successfully from Stocksight.")
# except Exception as e:
#     print(f"An error occurred while fetching data from Stocksight : {e}")  



# # Yahoo Finance 
# def fetch_yahoo_news(ticker='AAPL'):
#     try:
#         print("Fetching data from Yahoo Finance...")
#         stock = yf.Ticker(ticker)
#         yahoo_news_raw = stock.news
#         yahoo_news_raw  = [n for n in yahoo_news_raw  if n['title'].strip()]
#         yahoo_news = []
#         for news in yahoo_news_raw:
#             yahoo_news.append({
#                 'id': news.get('uuid'),
#                 'title': news.get('title'),
#                 'date': datetime.datetime.fromtimestamp(news.get('providerPublishTime')),
#                 'category': None,
#                 'tickers': news.get('relatedTickers'),
#                 'sentiment': None,
#                 'source': 'yahoo_news'
#             })
#         # print("yahoo_news :", yahoo_news)
#         print("Data fetched successfully from Yahoo Finance.")
#         return yahoo_news
#     except Exception as e:
#         print(f"An error occurred while fetching data from Yahoo Finance : {e}")
#         return []
# currently i don't know how it is possible to get more articles. We can comment this function I think until I find a way.
