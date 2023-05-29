import requests
import yfinance as yf
from GoogleNews import GoogleNews
import json
import datetime
import time
import os
from dotenv import load_dotenv


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



# # Degiro API
# Paste the code from Postman to get the updated session ID

def fetch_degiro_news(ticker='AAPL'):
    try:
        print("Fetching data from Degiro API...")
        url = 'https://trader.degiro.nl/dgtbxdsservice/newsfeed/v2/news-by-company' 
        stock = yf.Ticker(ticker)
        isin = stock.isin
        headers = {
            'authority': 'trader.degiro.nl',
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
            'cache-control': 'no-cache',
            'cookie': 'CookieConsent={stamp:%27g2rvM5TK90YFjtxdtmCTe3UfQvtokA5c28JlKZpJzqjq3nnUwLTN1w==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cmethod:%27explicit%27%2Cver:1%2Cutc:1683845362852%2Cregion:%27fr%27}; _gcl_au=1.1.456115840.1683845363; _rdt_uuid=1683845363879.c53ff580-c912-4cdc-b863-3a4882c034d0; _fbp=fb.1.1683845364454.322248438; _scid=d29ee0a9-a3bd-4eaa-a84f-09676cb062b6; _hjSessionUser_2703461=eyJpZCI6IjUxZjNmMTI2LWY0OTItNWEyOS05NmVmLTE4MWM1ODNlMDIyOSIsImNyZWF0ZWQiOjE2ODM4NDU0NjAyMDgsImV4aXN0aW5nIjp0cnVlfQ==; ln_or=eyIzNDUyNzg2IjoiZCJ9; _gid=GA1.2.234993630.1685341238; ab.storage.deviceId.48ef29a6-8098-447b-84fd-73dcf7ca322a=%7B%22g%22%3A%22d8bcdcca-2571-02d4-f20f-d81ffd537654%22%2C%22c%22%3A1608135359471%2C%22l%22%3A1685366933636%7D; ab.storage.userId.48ef29a6-8098-447b-84fd-73dcf7ca322a=%7B%22g%22%3A%22761567%22%2C%22c%22%3A1608135359466%2C%22l%22%3A1685366933637%7D; JSESSIONID=266A5E29C20056274A73AE01889B81E4.prod_b_128_5; _gat_UA-29259433-5=1; _ga_L69XHC4W9Q=GS1.1.1685365876.9.1.1685367688.57.0.0; ab.storage.sessionId.48ef29a6-8098-447b-84fd-73dcf7ca322a=%7B%22g%22%3A%22cc1ec20e-d6ec-5b9c-ab35-0f633da71680%22%2C%22e%22%3A1685369492335%2C%22c%22%3A1685366933635%2C%22l%22%3A1685367692335%7D; _scid_r=d29ee0a9-a3bd-4eaa-a84f-09676cb062b6; _uetsid=eef6af40fde811edbbbc5f037ae5afa8; _uetvid=1357a620f04e11edb6e2c3935d0e7d31; _ga_DK0QHRVZ0H=GS1.1.1685365876.11.1.1685367693.52.0.0; _ga=GA1.1.687530578.1683845398',
            'pragma': 'no-cache',
            'referer': 'https://trader.degiro.nl/trader/',
            'sec-ch-ua': '"Google Chrome";v="113", "Chromium";v="113", "Not-A.Brand";v="24"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
        }
        params = {
            'isin': isin, 
            'limit': 10, 
            'offset': 0,
            'sessionId': '0B4BB788BC2925188DAB0C59A6A9E1D8.prod_b_128_5',
            'languages': 'en,fr' 
        }

        response = requests.get(url, headers=headers, params=params)
        # print_curl_command(response.request)
        degiro_news = response.json()['data']['items']
        degiro_news = [n for n in degiro_news if n['title'].strip()]
        print("Data fetched successfully from Degiro API.")
        return degiro_news
    except Exception as e:
        print(f"Session ID expired. Please update it - {e}")
        return []

# # StockNews API 
# 100 calls per month for free
def fetch_stocknews_news(ticker='AAPL'):
    try:
        print("Fetching data from StockNews API...")
        url = 'https://stocknewsapi.com/api/v1'
        params = {
            'tickers': ticker,
            'items': 3,
            'page': 1, 
            'token': STOCKNEWS_API_KEY 
        }
        response = requests.get(url, params=params)
        stocknews_news = response.json()['data']
        stocknews_news = [n for n in stocknews_news if n['title'].strip()]
        print("Data fetched successfully from StockNews API.")
        return stocknews_news
    except Exception as e:
        print(f"An error occurred while fetching data from StockNews API: {e}")
        return []



# # TickerTick API
#  30 requests per minute from the same IP address
def fetch_tickertick_news(ticker='AAPL'):
    try:
        print("Fetching data from TickerTick API...")
        base_url = 'https://api.tickertick.com/feed'
        query = f'(or+TT:{ticker}+(or+T:fin_news+T:analysis+T:industry+T:earning+T:curated))'
        params = f'?q={query}&n=10'
        url = base_url + params
        response = requests.get(url)
        tickertick_news = response.json()['stories']
        tickertick_news = [n for n in tickertick_news if n['title'].strip()]
        print("Data fetched successfully from TickerTick API.")
        return tickertick_news
    except Exception as e:
        print(f"An error occurred while fetching data from TickerTick API: {e}")
        return []


# # Yahoo Finance 
def fetch_yahoo_news(ticker='AAPL'):
    try:
        print("Fetching data from Yahoo Finance...")
        stock = yf.Ticker(ticker)
        yahoo_news = stock.news
        yahoo_news = [n for n in yahoo_news if n['title'].strip()]
        print("Data fetched successfully from Yahoo Finance.")
        return yahoo_news
    except Exception as e:
        print(f"An error occurred while fetching data from Yahoo Finance : {e}")
        return []
  

# Interactive Brokers API
# Paste the code from Postman to get the updated cookie
def fetch_ib_news(ticker='AAPL'):

# Get the contract number from the ticker
    try:
        url = "https://www.interactivebrokers.co.uk/portal.proxy/v1/portal/iserver/secdef/search"

        payload = f'{{"symbol":"{ticker}","pattern":true,"referrer":"onebar"}}'
        headers = {
        'authority': 'www.interactivebrokers.co.uk',
        'accept': '*/*',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
        'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; IB_LANG=fr; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; cp.eu=2de6a9d6ad723d6a946958e1365381c7; _uetsid=ed7f5a60fdf511edbe389b7bccaa0c57; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685385602.8.0.1685385607.0.0.0; XYZAB_AM.LOGIN=0f03d91b75bbd2505de34b7738fc2d88193287df; XYZAB=0f03d91b75bbd2505de34b7738fc2d88193287df; USERID=102719436; IS_MASTER=true; AKA_A2=A; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=li8xwb2l&sl=t&tt=39na&obo=9&rl=1"; ibcust=3981e4ba2bb4b19da2d0a0df59668747',
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
        'x-ccp-session-id': '64742974.0000004c',
        'x-embedded-in': 'web',
        'x-request-id': '17',
        'x-service': 'AM.LOGIN',
        'x-session-id': '62f7f0ce-0332-4144-994b-86f2d596a0f2',
        'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
        'x-xyzab': '0f03d91b75bbd2505de34b7738fc2d88193287df'
        }

        response = requests.request("POST", url, headers=headers, data=payload)
        # print_curl_command(response.request)

        ib_contracts = response.json()[0]['conid']
        # ib_contracts = response.json()['conid']

        # print("ib_contracts",  ib_contracts)


    except Exception as e:
        print(f"Cookies expired. Please update it -  {e}")
        return []

# Get the news from the contract number
    try:
        print("Fetching data from Interactive Brokers API...")


        url = "https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&tzone="

        payload = f'{{"modKeywords":[],"categories":[],"contracts":["{ib_contracts}"],"content_type":[],"contract_filter_type":[]}}'
        headers = {
        'authority': 'www.interactivebrokers.co.uk',
        'accept': '*/*',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
        'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; IB_LANG=fr; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; cp.eu=2de6a9d6ad723d6a946958e1365381c7; _uetsid=ed7f5a60fdf511edbe389b7bccaa0c57; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685385602.8.0.1685385607.0.0.0; XYZAB_AM.LOGIN=0f03d91b75bbd2505de34b7738fc2d88193287df; XYZAB=0f03d91b75bbd2505de34b7738fc2d88193287df; USERID=102719436; IS_MASTER=true; AKA_A2=A; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=li8xwb2l&sl=t&tt=39na&obo=9&rl=1"; ibcust=3981e4ba2bb4b19da2d0a0df59668747',
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
        'x-ccp-session-id': '64742974.0000004c',
        'x-embedded-in': 'web',
        'x-request-id': '17',
        'x-service': 'AM.LOGIN',
        'x-session-id': '62f7f0ce-0332-4144-994b-86f2d596a0f2',
        'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
        'x-xyzab': '0f03d91b75bbd2505de34b7738fc2d88193287df'
        }

        response = requests.request("POST", url, headers=headers, data=payload)



        # print_curl_command(response.request)
        ib_news = response.json()['results']

        ib_news = [n for n in ib_news if n['headLineContent'].strip()]
        print("Data fetched successfully from Interactive Brokers API.")
        return ib_news
    except Exception as e:
        print(f"An error occurred while fetching data from Interactive Brokers API : {e}")
        return []


# # Google News 
class DateTimeEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, datetime.datetime):
            return o.isoformat()
        return super(DateTimeEncoder, self).default(o)

def fetch_google_news(ticker='AAPL'):
    try:
        print("Fetching data from Google News...")
        google_news = GoogleNews()
        google_news.search(f'{ticker} stock')
        google_news_results = google_news.result()
        google_news_final = json.dumps(google_news_results, cls=DateTimeEncoder)
        google_news_results_dict = json.loads(google_news_final)
        google_news_results_dict = [n for n in google_news_results_dict if n['title'].strip()]
        print("Data fetched successfully from Google News.")
        return google_news_results_dict
    except Exception as e:
        print(f"An error occurred while fetching data from Google News : {e}")
        return []

def print_news_headlines(degiro_news, stocknews_news, tickertick_news, yahoo_news, ib_news, google_news_results_dict):
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
        for n in yahoo_news:
            print("Yahoo",  n['title'])
        for n in ib_news:
            print("IB",  n['headLineContent'])   
        for n in google_news_results_dict:
            print("Google",  n['title'])
        print("News headlines printed successfully.")
    except Exception as e:
        print(f"An error occurred while printing news headlines: {e}")

def main(ticker='AAPL'):
    degiro_news = fetch_degiro_news(ticker)
    stocknews_news = fetch_stocknews_news(ticker)
    tickertick_news = fetch_tickertick_news(ticker)
    yahoo_news = fetch_yahoo_news(ticker)
    ib_news = fetch_ib_news(ticker)
    google_news_results_dict = fetch_google_news(ticker)
    print_news_headlines(degiro_news, stocknews_news, tickertick_news, yahoo_news, ib_news, google_news_results_dict)


if __name__ == "__main__":
    main()



# from stocksight import News  
# from googlenews import GoogleNews


# # Stocksight (not working currently)
# try:
#     print("Fetching data from Stocksight...")
#     news = News('AAPL')
#     print("Data fetched successfully from Stocksight.")
# except Exception as e:
#     print(f"An error occurred while fetching data from Stocksight : {e}")  