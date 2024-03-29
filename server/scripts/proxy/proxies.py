import requests
import random
import time
import threading
import os
from datetime import datetime, timedelta
import concurrent.futures



# Get the directory of the current script
script_dir = os.path.dirname(os.path.realpath(__file__))

# Construct the absolute paths
working_proxies_file = os.path.join(script_dir, "workingproxies.txt")
proxy_list_file = os.path.join(script_dir, "proxylist.txt")
blacklist_file = os.path.join(script_dir, "blacklist.txt")

# Create a threading event
check_proxies_done = threading.Event()

# Create a lock for writing to the working proxies file
working_proxies_lock = threading.Lock()

# Global variable to hold the last 50 tested proxies
last_tested_proxies = []

def get_proxies(url):
    try:
        response = requests.get(url)
        print(f"Retrieved proxies from {url}")
        return [line.strip() for line in response.text.split("\n") if line.strip() != ""]
    except Exception as e:
        print(f"Error retrieving proxies from {url}: {e}")
        return []

def test_google_news(proxy):
    global last_tested_proxies

    # If the proxy is in the last 50 tested proxies, return None
    if proxy in last_tested_proxies:
        return None

    print(f"Testing proxy {proxy} ")  
    try:
        url = "http://httpbin.org/ip"
        response = requests.get(url, timeout=10, proxies={"http": proxy, "https": proxy})
        if response.status_code == 200:
            print("Proxy working")
        else:
            print("Proxy does not work")
            # Add the proxy to the start of the list
            last_tested_proxies.insert(0, proxy)
            # If the list has more than 50 proxies, remove the oldest one
            if len(last_tested_proxies) > 50:
                last_tested_proxies.pop()
            return False  # If the proxy is not working, return False
    except Exception as e:
        print("Proxy does not work")
        # Add the proxy to the start of the list
        last_tested_proxies.insert(0, proxy)
        # If the list has more than 50 proxies, remove the oldest one
        if len(last_tested_proxies) > 50:
            last_tested_proxies.pop()
        return False  # If an exception occurs, the proxy is not working, return False

    try:
        # Attempting to get news for AAPL
        print(f"Testing proxy {proxy} with Google News RSS")  # Add this line
        url = "https://news.google.com/rss/search?q=AAPL"
        response = requests.get(url, timeout=10, proxies={"http": proxy, "https": proxy})
        if response.status_code == 200:
            print(f"Proxy {proxy} successfully accessed Google News RSS 😃")
            return True
        else:
            return False
    except requests.exceptions.RequestException as e:
        print(f"Error with proxy {proxy}: {e}")  # Modify this line
        if "Failed to establish a new connection" in str(e) or "[Errno 54] Connection reset by peer" in str(e):
            return None  # Return None if this specific error occurs
        return False



def check_working_proxies():
    print("Checking proxies for working status")
    while True:
        with open(working_proxies_file, "r") as file:
            working_proxies = [proxy.strip() for proxy in file.readlines()]
        with concurrent.futures.ThreadPoolExecutor() as executor:
            results = list(executor.map(test_google_news, working_proxies))
        working_proxies = [proxy for proxy, result in zip(working_proxies, results) if result]
        with open(working_proxies_file, "w") as file:
            for proxy in working_proxies:
                file.write(proxy + "\n")
        print("Finished checking working proxies. Waiting for 5 minutes before next check.")
        check_proxies_done.set()  # Signal that the check is done
        time.sleep(300)  # Wait for 5 minutes
        check_proxies_done.clear()  # Reset the event
        
        
def main():
    threading.Thread(target=check_working_proxies).start()
    check_proxies_done.wait()  # Wait for the check to be done
    while True:
        if not check_proxies_done.is_set():
            time.sleep(60)  # Wait for 1 minute before checking again
            continue
        with open(proxy_list_file, "r") as file:
            proxy_list = [line.strip() for line in file.readlines()]
        if not proxy_list:
            print("No more proxy URLs left in the list.")
            break
        filtered_proxy_list = [url for url in proxy_list if not url.startswith("USELESS:")]
        if filtered_proxy_list:  # Check if the list is not empty
            url = random.choice(filtered_proxy_list)
        else:
            print("No valid proxy URLs left in the list.")
            break  # or continue, or return, or raise an exception, depending on what you want to do in this case
        proxies = get_proxies(url)
        if not proxies:  # If get_proxies returned an empty list, skip this iteration
            continue
        working_proxies_found = False
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:  # Add max_workers here
            results = list(executor.map(test_google_news, proxies))
        for proxy, result in zip(proxies, results):
            with open(blacklist_file, "r") as file:
                blacklist = file.readlines()
            if proxy + "\n" in blacklist:
                continue
            with open(working_proxies_file, "r") as file:
                working_proxies = file.readlines()
            if result:
                with open(working_proxies_file, "a") as file:
                    if proxy + "\n" not in working_proxies:
                        print(f"Adding new working proxy: {proxy}")
                        print(f"")
                        file.write(proxy + "\n")
                        working_proxies_found = True
        if not working_proxies_found:
            print(f"No working proxies found in {url}. Marking as useless.")
            print(f"")
            proxy_list = [proxy if proxy != url else "USELESS:" + url for proxy in proxy_list]
            with open(proxy_list_file, "w") as file:
                for proxy_url in proxy_list:
                    file.write(proxy_url + "\n")

if __name__ == "__main__":
    main()
