import os
import json
import openai
import time

class SentimentAnalyzer:
    def __init__(self, api_key):
        openai.api_key = api_key

    def analyze_sentiment(self, text): 
        prompt="""Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain in the first line. Then
elaborate with one short and concise sentence on the next line """
        MODEL = "gpt-3.5-turbo"
        
        retries = 0
        while retries < 5:
            try:
                response = openai.ChatCompletion.create(
                    model=MODEL,
                    messages=[
                        {"role": "system", "content": prompt},
                        {"role": "user", "content": text},
                    ],
                    temperature=0,
                )
                break
            except openai.error.RateLimitError:
                print("RateLimitError: That model is currently overloaded with other requests. Retrying in 10 seconds.")
                time.sleep(10)
                retries += 1

        if retries == 5:
            raise Exception("Failed to get response from OpenAI after 5 retries.")
        
        #print(response)
        content = response['choices'][0]['message']['content']
        
        return content
    
    def analyze_news(self, file):
        results = []
        with open(file) as f:
            news = json.load(f)

        

        for article in news:
            headline = article['News headline']
            print(headline)
            contenido = self.analyze_sentiment(headline)
            #print(contenido)
            sentiment = ""
            description = ""
            sentiment_description = contenido.split("\n\n")
            if len(sentiment_description) >= 2:
                sentiment = sentiment_description[0]
                description = sentiment_description[1]
            elif len(sentiment_description) == 1:
                sentiment = sentiment_description[0]
            article['Sentiment'] = sentiment
            article['Description'] = description
            results.append(article)

            

        return results

 

def main():
    api_key = os.environ['OPENAI_API_KEY']
    analyzer = SentimentAnalyzer(api_key)

    # Analyze the news and save the results
    results = analyzer.analyze_news('news.json')
    with open('salida_chatgpt.json', 'w') as f:
        json.dump(results, f, indent=4)

if __name__ == "__main__":
    main()

