# AI Trading App

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]
[![LinkedIn][linkedin-shield]][linkedin-url]
[![Node.js][nodejs-shield]][nodejs-url]
[![React][react-shield]][react-url]
[![Python][python-shield]][python-url]
[![MongoDB][mongodb-shield]][mongodb-url]

## About
Welcome to the AI Trading App!

It can connect to Alpaca to get positions and orders, sell and buy stocks.
- You can import collaborative trading strategies
- Currently implementing sentiment analysis 

Credit for UI: [OktarianTB](https://github.com/OktarianTB/stock-trading-simulator)

Update: trailing orders removed

## Stack
Backend: NodeJS with Python Scripts, Material 5, ChatGPT, Claude

Frontend: React

Data: MongoDB

Devops: Github, Vercel, Render, Google Cloud Build, Gitguardian

Product Management: Productboard, Notion

Project Management: Jira

## Installation
Make sure you have NodeJS installed.

Make sure you have NodeJS installed. 

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

And run the client with:
```sh
npm run start
```

Open another terminal window and then run the server with:
```sh
npm run start
```

Then you have to set up the .env files for the server and the client:
Go to the different services, create accounts and get the API keys

here  /tradingapp/server/config/ you have an example file. Rename it .env and change the keys with yours

there /tradingapp/client/  you have an example file. Rename it .env and change the keys with yours

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
Fix bugs

Implement AI trading strategies

## Links
Roadmap: [Productboard](https://roadmap.productboard.com/21c090eb-9351-42c4-a248-b59747aa299f)

Discord: [Discord](https://discord.gg/Neu7KBrhV3)

<!-- Badges -->
[contributors-shield]: https://img.shields.io/github/contributors/your-repo/your-project.svg?style=for-the-badge
[contributors-url]: https://github.com/your-repo/your-project/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/your-repo/your-project.svg?style=for-the-badge
[forks-url]: https://github.com/your-repo/your-project/network/members
[stars-shield]: https://img.shields.io/github/stars/your-repo/your-project.svg?style=for-the-badge
[stars-url]: https://github.com/your-repo/your-project/stargazers
[issues-shield]: https://img.shields.io/github/issues/your-repo/your-project.svg?style=for-the-badge
[issues-url]: https://github.com/your-repo/your-project/issues
[license-shield]: https://img.shields.io/github/license/your-repo/your-project.svg?style=for-the-badge
[license-url]: https://github.com/your-repo/your-project/blob/master/LICENSE.txt
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://www.linkedin.com/in/vivienrichaud/
[nodejs-shield]: https://img.shields.io/badge/node.js-6DA55F?style=for-the-badge&logo=node.js&logoColor=white
[nodejs-url]: https://nodejs.org/
[react-shield]: https://img.shields.io/badge/React

