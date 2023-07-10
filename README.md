# AI Trading App

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]



## About
Welcome to the AI Trading App!

It can connect to Alpaca to get positions and orders, sell and buy stocks.
- You can import collaborative trading strategies
- Currently implementing sentiment analysis strategy

Credit for UI: [OktarianTB](https://github.com/OktarianTB/stock-trading-simulator)

Update: trailing orders removed

## Stack
Backend: NodeJS with Python Scripts, Material 5, AI: ChatGPT, Claude, Vertex

Frontend: React

Data: MongoDB

Devops: Github, Vercel, Render, Google Cloud Build, Gitguardian

Product Management: Notion

Project Management: Jira

## Hackathons
Friday, May 26 2023 - 6:00 PM
Anthropic AI Hackathon
Build AI Apps with leading AI models!
[Submitted project](https://lablab.ai/event/anthropic-ai-hackathon/ai-traders/ai-trading-app)

Friday, July 7 2023 - 6:00 PM
Google Cloud Vertex AI Hackathon
Be the first to build an AI App on Google’s AI models!
[Submitted project](https://lablab.ai/event/google-vertex-ai-hackathon/ai-traders/ai-traders)


## Installation
Make sure you have NodeJS installed. You can check your Node.js version by running the command node -v in your terminal. If your version is older than 14.20.1, you will need to update Node.js. Please make sure that node -v gives you a version after 14.20.1 before doing anything else. 



go to the server folder
```sh
cd server
```


Then install the required packages for the server with:

```sh
npm install
```

go to the client folder
```sh
cd ..
```
```sh
cd client
```

Install the required packages for the client with:
```sh
npm install
```



Then you have to set up the .env files for the server and the client:
Go to the different services, create accounts and get the API keys

here  /tradingapp/server/config/ you have an example file. Rename it .env and change the keys with yours

there /tradingapp/client/  you have an example file. Rename it .env and change the keys with yours


Please make sure you have created a .env in the server AND in the client or it will not work

To use Vertex you will need to create /tradingapp/server/config/googlecredentials.json with your google credentials



Then you can start the server and the client

Go to the client folder

And run the client with:
```sh
npm run start
```

Open another terminal window and then run the server with:

Go to the server folder

```sh
npm run start
```

Code explanation: [Video](https://www.loom.com/share/2411f7d34ea1491ab22c166957e107de) 



## Deployment
The front is optimized to be deployed on Vercel. Don't forget to add env variables.

The back is optimized to be deployed on Render. Don't forget to add env variables.

## Usage

You can edit you API keys in Settings

To buy stocks you can go in Search, search for a stock and buy

You can sell from the dashboard clicking on stocks ticker

You can implement a collaborative strategy that you found online in Strategies, copy paste it and add a name for the strategy. It will buy the stocks. This create a strategy portfolio that will show up on the dashboard

You can switch from paper trading to live trading in Config/Alpaca.js changing the apiurl



## To do

Improve the AI Fund Strategy: better news quality, better sentiment analysis

Implement transaction cost displays to evaluate strategy profitability is crucial

Implement other AI trading strategies

Implement crypto using Alpaca

Implement other brokers: deGiro

Fix bugs: currently a blocking bug on the collaborative strategy feature

## Links

Discord: [Discord](https://discord.gg/Neu7KBrhV3)

<!-- Badges -->
[contributors-shield]: https://img.shields.io/github/contributors/Louvivien/tradingapp.svg?style=for-the-badge
[contributors-url]: https://github.com/Louvivien/tradingapp/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/Louvivien/tradingapp.svg?style=for-the-badge
[forks-url]: https://github.com/Louvivien/tradingapp/network/members
[stars-shield]: https://img.shields.io/github/stars/Louvivien/tradingapp.svg?style=for-the-badge
[stars-url]: https://github.com/Louvivien/tradingapp/stargazers
[issues-shield]: https://img.shields.io/github/issues/Louvivien/tradingapp.svg?style=for-the-badge
[issues-url]: https://github.com/Louvivien/tradingapp/issues
[license-shield]: https://img.shields.io/github/license/Louvivien/tradingapp.svg?style=for-the-badge
[license-url]: https://github.com/Louvivien/tradingapp/blob/master/LICENSE.txt
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://www.linkedin.com/in/vivienrichaud/
[nodejs-shield]: https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white
[nodejs-url]: https://nodejs.org/
[react-shield]: https://img.shields.io/badge/React

