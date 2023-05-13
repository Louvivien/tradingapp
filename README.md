# AI Trading App



## About
Welcome to the AI Trading App!

It can connect to Alpaca to get positions and orders, sell and buy stocks with trailing orders.
It will implement AI strategies to trade.


Credit for UI: [OktarianTB](https://github.com/OktarianTB/stock-trading-simulator) 


## Installation
Make sure you have NodeJS installed. Then install the required packages for the server with:

```sh
npm install
```

And the required packages for the client with:
```sh
npm run install-client
```


Then run the server with:
```sh
npm run start
```
And run the client with:
```sh
cd client
npm run start
```

Then you have to set up the .env files for the server and the client:

here  /tradingapp/server/config/ you have an example file. Rename it .env and change the keys with yours

there /tradingapp/client/  you have an example file. Rename it .env and change the keys with yours


## Deployement
The front is optimized to be deployed on Vercel

The back is optimized to be deployed on Render


## To do
Fix bugs

Implement AI trading strategies



