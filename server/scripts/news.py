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
#  30 requests per minute from the same IP address
def fetch_tickertick_news(ticker='AAPL', period=1):
    try:
        logging.info("Fetching data from TickerTick API...")
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
                    logging.info("Data fetched successfully from TickerTick API.")
                    # print(tickertick_news)
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
        logging.info(f"An error occurred while fetching data from TickerTick API: {e}")
        return []


# # Google News
class DateTimeEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, datetime.datetime):
            return o.isoformat()
        return super(DateTimeEncoder, self).default(o)

def fetch_google_news(ticker='AAPL', period=1):
    try:
        logging.info("Fetching data from Google News...")

        # Get the current date and the date a week ago
        end_date = datetime.datetime.now()
        start_date = end_date - datetime.timedelta(days=period)
        formatted_start_date = start_date.strftime("%m/%d/%Y")
        formatted_end_date = end_date.strftime("%m/%d/%Y")

        logging.info(f"Start date: {formatted_start_date}, End date: {formatted_end_date}")

        # Create a GoogleNews object with the current date as the start and end date
        google_news_raw = GoogleNews(start=formatted_start_date, end=formatted_end_date)

        # Search for news related to the ticker and the ticker stock
        google_news_raw.search(f'{ticker}')
        google_news_results = google_news_raw.result()
        google_news_raw.search(f'{ticker} stock')
        google_news_results += google_news_raw.result()

        # logging.info("Google News raw results:", google_news_results)

        # Process the results
        google_news = []
        for news in google_news_results:
            if news.get('title').strip():  # Exclude news with empty title
                google_news.append({
                    'Id': generate_id(news.get('title'), news.get('datetime')),
                    'News headline': news.get('title'),
                    'Date': news.get('datetime'),  # Use the date from the news article
                    'Ticker': ticker,
                    'Stock name': ticker,
                    'Source': 'google_news'
                })

        logging.info("Data fetched successfully from Google News.")
        # print(google_news)
        return google_news

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

    try:
        json_output = json.dumps(news_data, cls=DateTimeEncoder, ensure_ascii=False, indent=4)

        # Save the JSON output to the data folder
        file_path = os.path.join('..', 'data', 'newsData.json')
        with open(file_path, 'w') as file:
            file.write(json_output)

        print("JSON output saved successfully.")
    except Exception as e:
        print(f"Error generating JSON or saving the output: {e}")
        json_output = "[]"

    return json_output



if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--ticker', default='AAPL')
    parser.add_argument('--period', type=int, default=1)
    args = parser.parse_args()
    # Convert the ticker to uppercase
    ticker = args.ticker.upper()

    main(args.ticker, args.period)



# Before running this file you need to update the session cookies for degiro and IB
# IB: filter requests on "search" in the browser network tab copy the curl command and paste it in Postman
    # paste the header section from Postman
# degiro: filter requests on "news" in the browser network tab copy the curl command and paste it in Postman
    # paste the sessionId from Postman



# # Degiro API
# Paste the code from Postman to get the updated session ID

# def fetch_degiro_news(ticker='AAPL', period=1):
#     try:
#         logging.info("Fetching data from Degiro API...")
#         url = 'https://trader.degiro.nl/dgtbxdsservice/newsfeed/v2/news-by-company' 
#         stock = yf.Ticker(ticker)
#         isin = stock.isin
#         headers = {
#         'authority': 'www.interactivebrokers.co.uk',
#         'accept': '*/*',
#         'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
#         'cache-control': 'no-cache',
#         'content-type': 'application/json; charset=utf-8',
#         'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; URL_PARAM="RL=1"; IB_LANG=fr; _uetsid=35e35da0ff9911ed9380097bf408f5eb; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685526901.9.0.1685526904.0.0.0; cp.eu=c0afea7e5e5e9ce6c65d6d8f9d48fa67; IBTOOLS_ACCT_ID=F9744995; XYZAB_AM.LOGIN=cc4d154cc3add92f9179ce18daa259be8a91fcc1; XYZAB=cc4d154cc3add92f9179ce18daa259be8a91fcc1; USERID=102719436; IS_MASTER=true; cp=fa2406ea3c81b6dff1bc8b6b5aa999b0; AKA_A2=A; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=libxz6w7&sl=3&tt=25k&obo=2&rl=1"; ibcust=0bb4584d299226695cdfc7603687b79a',
#         'origin': 'https://www.interactivebrokers.co.uk',
#         'pragma': 'no-cache',
#         'referer': 'https://www.interactivebrokers.co.uk/portal/',
#         'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
#         'sec-ch-ua-mobile': '?0',
#         'sec-ch-ua-platform': '"macOS"',
#         'sec-fetch-dest': 'empty',
#         'sec-fetch-mode': 'cors',
#         'sec-fetch-site': 'same-origin',
#         'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
#         'x-embedded-in': 'web',
#         'x-request-id': '11',
#         'x-service': 'AM.LOGIN',
#         'x-session-id': '1658a1d3-8d17-4839-9aa4-6dd7233e0479',
#         'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
#         'x-xyzab': 'cc4d154cc3add92f9179ce18daa259be8a91fcc1'
#         }
#         params = {
#             'isin': isin, 
#             'limit': 10, 
#             'offset': 0,
#             'sessionId': '71F230DB5E6264735B588335020700A2.prod_b_128_5',
#             'languages': 'en,fr' 
#         }

#         degiro_news = []
#         while True:
#             response = requests.get(url, headers=headers, params=params)
#             # print_curl_command(response.request)
#             degiro_news_raw = response.json()['data']['items']
#             degiro_news_raw = [n for n in degiro_news_raw  if n['title'].strip()]
#             for news in degiro_news_raw:
#                 news_date = datetime.datetime.strptime(news.get('date'), "%Y-%m-%dT%H:%M:%SZ")
#                 if (datetime.datetime.now() - news_date).days > period:
#                     logging.info("Data fetched successfully from Degiro API.")
#                     return degiro_news
#                 degiro_news.append({
#                     'id': news.get('id') or generate_id(news.get('title'), news_date),
#                     'title': news.get('title'),
#                     'date': news_date,
#                     'category': news.get('category'),
#                     'tickers': news.get('isins'),
#                     'sentiment': None,
#                     'source': 'degiro_news'
#                 })
#             params['offset'] += 10
#             logging.info(f"Fetching next 10 articles. Current offset: {params['offset']}")
#     except Exception as e:
#         logging.info(f"degiro: Session ID expired. Please update it - {e}")
#         return []



        # try:
        #     degiro_news = executor.submit(fetch_degiro_news, ticker, period)
        # except Exception as e:
        #     logging.error(f"An error occurred while fetching data from Degiro: {e}", file=sys.stderr)
        #     degiro_news = []

  

# Interactive Brokers API
# Paste the code from Postman to get the updated cookie
# def fetch_ib_news(ticker='AAPL', period=1):
#     # Get the contract number from the ticker
#     try:
#         logging.info("Fetching contract number from Interactive Brokers API...")
#         url = "https://www.interactivebrokers.co.uk/portal.proxy/v1/portal/iserver/secdef/search"

#         payload = f'{{"symbol":"{ticker}","pattern":true,"referrer":"onebar"}}'
#         headers = {
#         'authority': 'www.interactivebrokers.co.uk',
#         'accept': '*/*',
#         'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
#         'cache-control': 'no-cache',
#         'content-type': 'application/json; charset=utf-8',
#         'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; URL_PARAM="RL=1"; IB_LANG=fr; _uetsid=35e35da0ff9911ed9380097bf408f5eb; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685526901.9.0.1685526904.0.0.0; cp.eu=c0afea7e5e5e9ce6c65d6d8f9d48fa67; IBTOOLS_ACCT_ID=F9744995; AKA_A2=A; XYZAB_AM.LOGIN=cc4d154cc3add92f9179ce18daa259be8a91fcc1; XYZAB=cc4d154cc3add92f9179ce18daa259be8a91fcc1; USERID=102719436; IS_MASTER=true; cp=c79346603608d4864a123ddef6b7a05b; ibcust=ea846d36edd98a82800db7474bf0c407; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=liblm85f&sl=n&tt=8xq&obo=g&rl=1"',
#         'origin': 'https://www.interactivebrokers.co.uk',
#         'pragma': 'no-cache',
#         'referer': 'https://www.interactivebrokers.co.uk/portal/',
#         'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
#         'sec-ch-ua-mobile': '?0',
#         'sec-ch-ua-platform': '"macOS"',
#         'sec-fetch-dest': 'empty',
#         'sec-fetch-mode': 'cors',
#         'sec-fetch-site': 'same-origin',
#         'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
#         'x-embedded-in': 'web',
#         'x-request-id': '10',
#         'x-service': 'AM.LOGIN',
#         'x-session-id': '9d66e627-4c4c-4e40-c0ed-3b7647e5e2fe',
#         'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
#         'x-xyzab': 'cc4d154cc3add92f9179ce18daa259be8a91fcc1'
#         }

#         response = requests.request("POST", url, headers=headers, data=payload)
#         print_curl_command(response.request)

#         ib_contracts = response.json()[0]['conid']
#         logging.info(f"Contract number for {ticker}: {ib_contracts}")

#     except Exception as e:
#         logging.error(f"IB: Cookies expired. Please update it -  {e}")
#         return []

#     # Get the news from the contract number
#     try:
#         logging.info("Fetching news from Interactive Brokers API...")
#         url = "https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&tzone="

#         payload = f'{{"modKeywords":[],"categories":[],"contracts":["{ib_contracts}"],"content_type":[],"contract_filter_type":[]}}'
#         headers = headers

#         ib_news = []
#         while True:
#             response = requests.request("POST", url, headers=headers, data=payload)
#             # print_curl_command(response.request)

#             ib_news_raw = response.json()['results']
#             ib_news_raw = [n for n in ib_news_raw if n['headLineContent'].strip()]
#             if not ib_news_raw:
#                 break

#             for news in ib_news_raw:
#                 news_date = datetime.datetime.fromtimestamp(news.get('time') / 1000)
#                 if (datetime.datetime.now() - news_date).days > period:
#                     logging.info("Data fetched successfully from Interactive Brokers API.")
#                     return ib_news
#                 ib_news.append({
#                     'id': generate_id(news.get('headLineContent'), news_date),
#                     'title': news.get('headLineContent'),
#                     'date': news_date,
#                     'category': None,
#                     'tickers': [news.get('main_conid')],
#                     'sentiment': news.get('sentiment'),
#                     'source': 'ib_news'
#                 })
#             last_time = str(ib_news_raw[-1]['time'])
#             last_newsId = ib_news_raw[-1]['newsId']
#             url = f"https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&nav_anchor={last_time},{last_newsId}&tzone="
#             logging.info(f"Fetching next set of articles. Last time: {last_time}, Last newsId: {last_newsId}")
#     except Exception as e:
#         logging.error(f"An error occurred while fetching data from Interactive Brokers API : {e}")
#         return []


        # try:
        #     ib_news = executor.submit(fetch_ib_news, ticker, period)
        # except Exception as e:
        #     logging.error(f"An error occurred while fetching data from Interactive Brokers: {e}", file=sys.stderr)
        #     ib_news = []
