'''Class definition for ChatGPT_Client'''

import logging
import time
import undetected_chromedriver as uc

# from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
import selenium.common.exceptions as Exceptions
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait



options = uc.ChromeOptions()
options.binary_location = '/opt/render/project/.render/chrome/opt/google/chrome/google-chrome'

options.add_argument('--disable-extensions')
options.add_argument('--disable-gpu')
options.add_argument('--no-sandbox') 
options.add_argument('start-maximized')
options.add_argument('disable-infobars')
options.add_argument('--headless=new')
options.add_argument('--disable-dev-shm-usage')
options.add_argument('--remote-debugging-port=9222')
options.add_argument('--disable-browser-side-navigation')
options.add_argument('--disable-features=VizDisplayCompositor')
options.add_argument('--disable-blink-features=AutomationControlled')


logging.basicConfig(
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt='%Y/%m/%d %H:%M:%S',
    level=logging.INFO  
)


class ChatGPT_Client:
    '''ChatGPT_Client class to interact with ChatGPT'''

    login_xq    = '//button[//div[text()="Log in"]]'
    continue_xq = '//button[text()="Continue"]'
    next_cq     = 'prose'
    button_tq   = 'button'
    # next_xq     = '//button[//div[text()='Next']]'
    done_xq     = '//button[//div[text()="Done"]]'
    plugin_xq    = '(//button[//span[text()="No plugins enabled"]])[5]'
    plugin1_xq    = '//*[contains(text(), "Options Pro")]'
    plugin2_xq    = '//*[contains(text(), "Polygon")]'
    plugin3_xq    = '//*[contains(text(), "Public")]'



    chatbox_cq  = 'text-base'
    wait_cq     = 'text-2xl'
    reset_xq    = '//a[text()="New chat"]'
    regen_xq    = '//div[text()="Regenerate response"]'


    def __init__(
        self,
        username :str,
        password :str,
        headless :bool = True,
        cold_start :bool = False,
        verbose :bool = False
    ):
        if verbose:
            logging.getLogger().setLevel(logging.INFO)
            logging.info('Verbose mode active')
        options = uc.ChromeOptions()
        options.add_argument('--incognito')
        if headless:
            options.add_argument('--headless')

        logging.info('Loading undetected Chrome')
        self.browser = uc.Chrome(
            options=options,  
            headless=headless,
            version_main=112
        )
        self.browser.set_page_load_timeout(30)
        logging.info('Opening chatgpt')

        # Retry mechanism for opening the ChatGPT page
        for i in range(3):  # Try 3 times
            try:
                self.browser.get('https://chat.openai.com/auth/login?next=/chat')
                logging.info('Successfully opened ChatGPT')

                # Wait for the login button to appear
                # self.pass_verification()

                WebDriverWait(self.browser, 10).until(EC.presence_of_element_located((By.XPATH, self.login_xq)))
                logging.info('Login button is present')

                break  # If successful, break the loop

            except Exception as e:
                logging.error(f'Failed to open ChatGPT on attempt {i+1}')
                if i == 2:  # If this was the last attempt, return
                    return
                time.sleep(5)  # Wait before trying again

        if not cold_start:
            self.pass_verification()
            self.login(username, password)
        logging.info('ChatGPT is ready to interact')
        time.sleep(2)





    def pass_verification(self):
        '''
        Performs the verification process on the page if challenge is present.

        This function checks if the login page is displayed in the browser.
        In that case, it looks for the verification button.
        This process is repeated until the login page is no longer displayed.

        Returns:
            None
        '''
        while self.check_login_page():
            verify_button = self.browser.find_elements(By.ID, 'challenge-stage')
            if len(verify_button):
                try:
                    verify_button[0].click()
                    logging.info('Clicked verification button')
                except Exceptions.ElementNotInteractableException:
                    logging.info('Verification button is not present or clickable')
            time.sleep(1)
        return

    def check_login_page(self):
        '''
        Checks if the login page is displayed in the browser.

        Returns:
            bool: True if the login page is not present, False otherwise.
        '''
        login_button = self.browser.find_elements(By.XPATH, self.login_xq)
        return len(login_button) == 0
    
    def login(self, username :str, password :str):
        '''
        Performs the login process with the provided username and password.

        This function operates on the login page.
        It finds and clicks the login button,
        fills in the email and password textboxes

        Args:
            username (str): The username to be entered.
            password (str): The password to be entered.

        Returns:
            None
        '''
        for i in range(3):  # Try 3 times
            try:
                # Find login button, click it
                login_button = self.sleepy_find_element(By.XPATH, self.login_xq)
                login_button.click()
                logging.info('Clicked login button')
                time.sleep(1)

                # Find email textbox, enter e-mail
                email_box = self.sleepy_find_element(By.ID, 'username')
                email_box.send_keys(username)
                logging.info('Filled email box')

                # Click continue
                continue_button = self.sleepy_find_element(By.XPATH, self.continue_xq)
                continue_button.click()
                time.sleep(1)
                logging.info('Clicked continue button')

                # Find password textbox, enter password
                pass_box = self.sleepy_find_element(By.ID, 'password')
                pass_box.send_keys(password)
                logging.info('Filled password box')
                # Click continue
                continue_button = self.sleepy_find_element(By.XPATH, self.continue_xq)
                continue_button.click()
                time.sleep(3)
                logging.info('Logged in')
                break  # If successful, break the loop
            except Exception as e:
                logging.error(f'Failed to login on attempt {i+1}: {e}')
                if i == 2:  # If this was the last attempt, return
                    return
                time.sleep(5)  # Wait before trying again

        try:
            # Pass introduction
            next_button = self.browser.find_element(By.CLASS_NAME, self.next_cq)
            next_button = next_button.find_elements(By.TAG_NAME, self.button_tq)[0]
            next_button.click()
            time.sleep(1)
            next_button = self.browser.find_element(By.CLASS_NAME, self.next_cq)
            next_button = next_button.find_elements(By.TAG_NAME, self.button_tq)[1]
            next_button.click()
            time.sleep(1)
            next_button = self.browser.find_element(By.CLASS_NAME, self.next_cq)
            done_button = next_button.find_elements(By.TAG_NAME, self.button_tq)[1]
            done_button.click()
            logging.info('Info screen passed')
            url = 'https://chat.openai.com/?model=gpt-4-plugins'
            self.browser.get(url)
            time.sleep(1)
            logging.info(f'Navigated to URL: {url}')

            for _ in range(10):  # try 5 times
                try:
                    plugin_button = self.browser.find_element(By.XPATH, self.plugin_xq)
                    plugin_button.click()
                    logging.info(f'Clicked plugin button')
                    break  # if successful, break the loop
                except Exception as e:
                    logging.error(f'Failed to click plugin button')
                    time.sleep(1)  # wait before trying again

            time.sleep(2)

            for _ in range(5):  # try 5 times
                try:
                    plugin_enabled = self.browser.find_element(By.XPATH, self.plugin1_xq)
                    plugin_enabled.click()
                    logging.info(f'Enabled plugin1')
                    break  # if successful, break the loop
                except Exception as e:
                    logging.error(f'Failed to enable plugin1')
                    time.sleep(1)  # wait before trying again


            plugin_enabled = self.browser.find_element(By.XPATH, self.plugin2_xq)
            plugin_enabled.click()
            logging.info(f'Enabled plugin2') 
            time.sleep(1)
            plugin_enabled = self.browser.find_element(By.XPATH, self.plugin3_xq)
            plugin_enabled.click()
            logging.info(f'Enabled plugin3') 
            time.sleep(1)


        except Exceptions.NoSuchElementException:
            logging.info('Info screen skipped')

    def sleepy_find_element(self, by, query, attempt_count :int =20, sleep_duration :int =1):
        '''
        Finds the web element using the locator and query.

        This function attempts to find the element multiple times with a specified
        sleep duration between attempts. If the element is found, the function returns the element.

        Args:
            by (selenium.webdriver.common.by.By): The method used to locate the element.
            query (str): The query string to locate the element.
            attempt_count (int, optional): The number of attempts to find the element. Default: 20.
            sleep_duration (int, optional): The duration to sleep between attempts. Default: 1.

        Returns:
            selenium.webdriver.remote.webelement.WebElement: Web element or None if not found.
        '''
        for _count in range(attempt_count):
            item = self.browser.find_elements(by, query)
            if len(item) > 0:
                item = item[0]
                logging.info(f'Element {query} has found')
                break
            logging.info(f'Element {query} is not present, attempt: {_count+1}')
            time.sleep(sleep_duration)
        return item

    def wait_to_disappear(self, by, query, sleep_duration=1):
        '''
        Waits until the specified web element disappears from the page.

        This function continuously checks for the presence of a web element.
        It waits until the element is no longer present on the page.
        Once the element has disappeared, the function returns.

        Args:
            by (selenium.webdriver.common.by.By): The method used to locate the element.
            query (str): The query string to locate the element.
            sleep_duration (int, optional): The duration to sleep between checks. Default: 1.

        Returns:
            None
        '''

        while True:
            thinking = self.browser.find_elements(by, query)
            if len(thinking) == 0:
                logging.info(f'Element {query} is present, waiting')
                break
            time.sleep(sleep_duration)
        return
    
    def interact(self, question : str):
        '''
        Sends a question and retrieves the answer from the ChatGPT system.

        This function interacts with the ChatGPT.
        It takes the question as input and sends it to the system.
        The question may contain multiple lines separated by '\n'. 
        In this case, the function simulates pressing SHIFT+ENTER for each line.

        After sending the question, the function waits for the answer.
        Once the response is ready, the response is returned.

        Args:
            question (str): The interaction text.

        Returns:
            str: The generated answer.
        '''
        WebDriverWait(self.browser, 10).until(EC.presence_of_element_located((By.TAG_NAME, 'textarea')))
        text_area = self.browser.find_element(By.TAG_NAME, 'textarea')
        for each_line in question.split('\n'):
            text_area.send_keys(each_line)
            text_area.send_keys(Keys.SHIFT + Keys.ENTER)
        text_area.send_keys(Keys.RETURN)
        logging.info('Message sent, waiting for response')
        self.wait_to_disappear(By.CLASS_NAME, self.wait_cq)
        answer = self.browser.find_elements(By.CLASS_NAME, self.chatbox_cq)[-1]
        logging.info('Answer is ready')
        print(answer.text)
        # delete_button = self.browser.find_element(By.XPATH, '(//button[@class="p-1 hover:text-white"])[1]')
        # delete_button.click()
        # logging.info('Clicked delete conversation')
        return answer.text

    def reset_thread(self):
        '''Function to close the current thread and start new one'''
        self.browser.find_element(By.XPATH, self.reset_xq).click()
        logging.info('New thread is ready')

    def regenerate_response(self):
        '''
        Closes the current thread and starts a new one.

        Args:
            None

        Returns:
            None
        '''
        try:
            regen_button = self.browser.find_element(By.XPATH, self.regen_xq)
            regen_button.click()
            logging.info('Clicked regenerate button')
            self.wait_to_disappear(By.CLASS_NAME, self.wait_cq)
            answer = self.browser.find_elements(By.CLASS_NAME, self.chatbox_cq)[-1]
            logging.info('New answer is ready')
        except Exceptions.NoSuchElementException:
            logging.error('Regenerate button is not present')
        return answer



if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('username')
    parser.add_argument('password')
    args = parser.parse_args()

    print('Navigating to the URL...', flush=True)
    chatgpt = ChatGPT_Client(args.username, args.password)
    result = chatgpt.interact('Hello, how are you today')

    print(result)