# AI Trading App



## About
Welcome to the AI Trading App!

It can connect to Alpaca to get positions and orders, sell and buy stocks.
It will implement AI strategies to trade.


Credit for UI: [OktarianTB](https://github.com/OktarianTB/stock-trading-simulator) 


Update: trailing orders removed

## Stack
Backend: NodeJS with Python Scripts, Material 5

Frontend: React

Data: MongoDB

Devops: Github, Vercel, Render, Google Cloud Build

Product Management: Productboard, Notion

Project Management: Jira


## Installation
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

And the required packages for the client with:
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


## Deployment
The front is optimized to be deployed on Vercel. Don't forget to add env variables.

The back is optimized to be deployed on Render. Don't forget to add env variables.
Web service → Python → Root Directory: ./server → Build Command: ./install_dependencies.sh → Start Command:
export PATH="${PATH}:/opt/render/project/.render/chrome/opt/google/chrome" && yarn start



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




