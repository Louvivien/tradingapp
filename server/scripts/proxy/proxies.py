import requests
import random
import time
import threading
from datetime import datetime, timedelta
import os

# Get the directory of the current script
script_dir = os.path.dirname(os.path.realpath(__file__))

# Construct the absolute paths
working_proxies_file = os.path.join(script_dir, "workingproxies.txt")
proxy_list_file = os.path.join(script_dir, "proxylist.txt")
blacklist_file = os.path.join(script_dir, "blacklist.txt")

def get_proxies(url):
    try:
        response = requests.get(url)
        print(f"Retrieved proxies from {url}")
        return [line.strip() for line in response.text.split("\n") if line.strip() != ""]
    except Exception as e:
        print(f"Error retrieving proxies from {url}: {e}")
        if "Failed to establish a new connection" in str(e):
            return None  
        return []

def find_working_proxy(proxies):
    url = "http://httpbin.org/ip"
    for proxy in proxies:
        try:
            response = requests.get(url, proxies={"http": proxy, "https": proxy}, timeout=30)
            if response.status_code == 200:
                return proxy
        except Exception as e:
            return None
    print("No working proxy found")
    return None

def test_google_news(proxy):
    headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
        }
    proxies = {
        'https': proxy,
    }
    try:
        response = requests.get('https://news.google.com/', headers=headers, proxies=proxies, timeout=10)
        if response.status_code == 429:
            with open(blacklist_file, "a") as file:
                file.write(proxy + "\n")
            return False
        else:
            print(f"Proxy {proxy} successfully accessed Google News 😃")
            print(f"")
            return True
    except Exception as e:
        if "Failed to establish a new connection" in str(e):
            return None  # Return None if this specific error occurs
        return False

def check_working_proxies():
    while True:
        with open(working_proxies_file, "r") as file:
            working_proxies = [proxy.strip() for proxy in file.readlines()]
        for proxy in working_proxies:
            if not test_google_news(proxy):
                working_proxies.remove(proxy)
        with open(working_proxies_file, "w") as file:
            for proxy in working_proxies:
                file.write(proxy + "\n")
        print("Finished checking working proxies. Waiting for 30 minutes before next check.")
        print(f"")
        time.sleep(1800) 

def main():
    threading.Thread(target=check_working_proxies).start()
    while True:
        with open(proxy_list_file, "r") as file:
            proxy_list = [line.strip() for line in file.readlines()]
        if not proxy_list:
            print("No more proxy URLs left in the list.")
            break
        url = random.choice([url for url in proxy_list if not url.startswith("USELESS:")])
        proxies = get_proxies(url)
        if proxies is None:  # If get_proxies returned None, skip this iteration
            continue
        working_proxies_found = False
        for proxy in proxies:
            with open(blacklist_file, "r") as file:
                blacklist = file.readlines()
            if proxy + "\n" in blacklist:
                continue
            with open(working_proxies_file, "r") as file:
                working_proxies = file.readlines()
            if test_google_news(proxy):
                with open(working_proxies_file, "a") as file:
                    if proxy + "\n" not in working_proxies:
                        print(f"Adding new working proxy: {proxy}")
                        print(f"")
                        file.write(proxy + "\n")
                        working_proxies_found = True
            if test_google_news(proxy) is None:
                continue  
        if not working_proxies_found:
            print(f"No working proxies found in {url}. Marking as useless.")
            print(f"")
            proxy_list.remove(url)
            proxy_list.append("USELESS:" + url)  # Mark the URL as useless
            with open(proxy_list_file, "w") as file:
                for proxy_url in proxy_list:
                    file.write(proxy_url + "\n")

if __name__ == "__main__":
    main()
