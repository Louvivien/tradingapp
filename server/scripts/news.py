import requests
import yfinance as yf
# from stocksight import News  
# from googlenews import GoogleNews
from GoogleNews import GoogleNews
import json
import datetime
import time



def print_curl_command(request):
    command = "curl '{uri}' -X {method} -H {headers} {data}"
    method = request.method
    uri = request.url
    data = "-d '{0}'".format(request.body) if request.body else ""
    headers = ['"{0}: {1}"'.format(k, v) for k, v in request.headers.items()]
    headers = " -H ".join(headers)
    print(command.format(uri=uri, method=method, headers=headers, data=data))



# # Degiro API
try:
    print("Fetching data from Degiro API...")
    url = 'https://trader.degiro.nl/dgtbxdsservice/newsfeed/v2/news-by-company' 
    aapl = yf.Ticker("AAPL")
    isin = aapl.isin
    # print("AAPL ISIN: ", isin)
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
        'sessionId': '97956FE1154F885716A908080A37B383.prod_b_128_5',
        'languages': 'en,fr' 
    }

    response = requests.get(url, headers=headers, params=params)
    # print_curl_command(response.request)
    degiro_news = response.json()['data']['items']
    degiro_news = [n for n in degiro_news if n['title'].strip()]
    # degiro_news = response.json()

    print("Data fetched successfully from Degiro API.")
except Exception as e:
    print(f"An error occurred while fetching data from Degiro API: {e}")


# # StockNews API 
# 100 calls per month for free
try:

    print("Fetching data from StockNews API...")

    url = 'https://stocknewsapi.com/api/v1'
    params = {
        'tickers': 'AAPL',
        'items': 3,
        'page': 1, 
        'token': '4aqnf4c3gmecqb4nemf14vqhavhpdpybyrllyl3v' 
    }
    response = requests.get(url, params=params)
    # print_curl_command(response.request)
    print(response)
    # stocknews_news = response.json()
    stocknews_news = response.json()['data']
    stocknews_news = [n for n in stocknews_news if n['title'].strip()]
    print("Data fetched successfully from StockNews API.")
except Exception as e:
    print(f"An error occurred while fetching data from StockNews API: {e}")

# # TickerTick API
#  30 requests per minute from the same IP address
try:
    print("Fetching data from TickerTick API...")

    base_url = 'https://api.tickertick.com/feed'
    query = '(or+TT:AAPL+(or+T:fin_news+T:analysis+T:industry+T:earning+T:curated))'
    params = f'?q={query}&n=10'
    url = base_url + params

    response = requests.get(url)
    # print_curl_command(response.request)

    # tickertick_news = response.json()
    tickertick_news = response.json()['stories']
    tickertick_news = [n for n in tickertick_news if n['title'].strip()]


    print("Data fetched successfully from TickerTick API.")
except Exception as e:
    print(f"An error occurred while fetching data from TickerTick API: {e}")



# # Yahoo Finance 
try:
    print("Fetching data from Yahoo Finance...")
    aapl = yf.Ticker("AAPL")

    yahoo_news = aapl.news
    yahoo_news = [n for n in yahoo_news if n['title'].strip()]
    print("Data fetched successfully from Yahoo Finance.")
except Exception as e:
    print(f"An error occurred while fetching data from Yahoo Finance : {e}")    

# # Stocksight (not working currently)
# try:
#     print("Fetching data from Stocksight...")
#     news = News('AAPL')
#     print("Data fetched successfully from Stocksight.")
# except Exception as e:
#     print(f"An error occurred while fetching data from Stocksight : {e}")    

# Interactive Brokers API
try:
    url = "https://www.interactivebrokers.co.uk/tws.proxy/news2/search2?lang=en_US&tzone="

    payload = "{\"modKeywords\":[],\"categories\":[],\"contracts\":[\"265598\"],\"content_type\":[],\"contract_filter_type\":[]}"
    headers = {
    'authority': 'www.interactivebrokers.co.uk',
    'accept': '*/*',
    'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'content-type': 'application/json; charset=utf-8',
    'cookie': 'SBID=qlku8ucrw2olhj2l78s; IB_PRIV_PREFS=0%7C0%7C0; web=1038835950; persistPickerEntry=-975354114; ROUTEIDD=.ny5japp2; PHPSESSID=1uatb4ikep5o234kpc05k956t1; _gcl_au=1.1.1159424871.1683845124; _ga=GA1.1.1577574560.1683845124; IB_LGN=T; _fbp=fb.2.1683845124910.2067711817; _tt_enable_cookie=1; _ttp=KwcgLD3IO-uMJr9oPKCG2dtx7yM; pastandalone=""; ROUTEID=.zh4www2-internet; IB_LANG=fr; credrecovery.web.session=36fb301f70cf85a0839df3622cdc2229; _uetsid=ed7f5a60fdf511edbe389b7bccaa0c57; _uetvid=849ca6d0f04d11eda4f6136e3642cc6b; _ga_V74YNFMQMQ=GS1.1.1685372607.7.0.1685372610.0.0.0; AKA_A2=A; XYZAB_AM.LOGIN=5838db52adaeb13b4ddc04bbbca4db3062e84086; XYZAB=5838db52adaeb13b4ddc04bbbca4db3062e84086; USERID=102719436; IS_MASTER=true; cp.eu=e8757ef0457b5ab269728a722fa003dd; ibcust=d9bcb8f832a61f1f11bfbbcde42e9fc5; RT="z=1&dm=www.interactivebrokers.co.uk&si=e3e1ccec-d396-4feb-812d-b90d1172b25b&ss=li8xwb2l&sl=f&tt=gqt&obo=5&rl=1"',
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
    'x-ccp-session-id': '64742974.00000041',
    'x-embedded-in': 'web',
    'x-request-id': '17',
    'x-service': 'AM.LOGIN',
    # To update:
    'x-session-id': 'cc85cf41-a21c-4417-ae52-e9e3cfd505bc',
    'x-wa-version': '61d75d4,Mon, 15 May 2023 07:09:01 -0400/2023-05-15T15:42:00.639Z',
    'x-xyzab': '5838db52adaeb13b4ddc04bbbca4db3062e84086'
}

    response = requests.request("POST", url, headers=headers, data=payload)
    print_curl_command(response.request)
    time.sleep(1)
    ib_news = response.json()['results']
    ib_news = [n for n in ib_news if n['headLineContent'].strip()]
    # print(response.text)



    print("Data fetched successfully from Interactive Brokers API.")

except Exception as e:
    print(f"An error occurred while fetching data from Interactive Brokers API : {e}")  

# # Google News 
class DateTimeEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, datetime.datetime):
            return o.isoformat()

        return super(DateTimeEncoder, self).default(o)

try:
    print("Fetching data from Google News...")
    google_news = GoogleNews()
    google_news.search(f'Apple stock')
    google_news_results = google_news.result()
    google_news_final = json.dumps(google_news_results, cls=DateTimeEncoder)
    google_news_results_dict = json.loads(google_news_final)
    google_news_results_dict = [n for n in google_news_results_dict if n['title'].strip()]
    print("Data fetched successfully from Google News.")

except Exception as e:
    print(f"An error occurred while fetching data from Google News : {e}")


# Print news headlines
try:
    print("Printing news headlines...")
    # print("Degiro news:",  degiro_news)
    # print("Stocknews news:", stocknews_news)
    # print("TickerTick news:", tickertick_news)
    # print("Yahoo news:", yahoo_news)
    # print("IB news:", ib_news)
    # print("Google news:", google_news_results_dict)

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