# Trading App



## About
Welcome to my Trading App!

It can connect to Alpaca to get positions and orders, sell and buy stocks.

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

## To do
Delete const data = require("../config/stocksData") from stockController.
Add loading on the PageTemplate
Manage API limit for tiingo



