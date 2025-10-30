const User = require("../models/userModel");
const Strategy = require("../models/strategyModel");
const Portfolio = require("../models/portfolioModel");
const StrategyLog = require("../models/strategyLogModel");
const News = require("../models/newsModel");
const { getAlpacaConfig } = require("../config/alpacaConfig");
const Alpaca = require('@alpacahq/alpaca-trade-api');
const axios = require("axios");
const moment = require('moment');
const crypto = require('crypto');
const extractGPT = require("../utils/ChatGPTplugins");
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { distance } = require('fastest-levenshtein');
const Axios = require("axios");
const { normalizeRecurrence, computeNextRebalanceAt } = require('../utils/recurrence');
const { recordStrategyLog } = require('../services/strategyLogger');



const VALID_RECURRENCES = new Set(['every_minute','every_5_minutes','every_15_minutes','hourly','daily','weekly','monthly']);


//Work in progress: prompt engineering (see jira https://ai-trading-bot.atlassian.net/browse/AI-76)

const sanitizeSymbol = (value) => {
  if (!value) {
    return null;
  }
  return String(value).trim().toUpperCase();
};

const toNumber = (value, fallback = null) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const extractTargetPositions = (rawPositions = []) => {
  if (!Array.isArray(rawPositions)) {
    return [];
  }

  return rawPositions
    .map((entry) => {
      const symbol = sanitizeSymbol(
        entry?.symbol
        || entry?.ticker
        || entry?.Ticker
        || entry?.['Asset ticker']
        || entry?.['asset ticker']
      );

      if (!symbol) {
        return null;
      }

      const quantity = toNumber(
        entry?.targetQuantity
          ?? entry?.quantity
          ?? entry?.Quantity
          ?? entry?.qty
          ?? entry?.['Quantity'],
        null,
      );

      const totalCost = toNumber(
        entry?.targetValue
          ?? entry?.value
          ?? entry?.amount
          ?? entry?.['Total Cost']
          ?? entry?.['Total cost']
          ?? entry?.['Total'],
        null,
      );

      const weight = toNumber(entry?.targetWeight, null);

      return {
        symbol,
        targetQuantity: quantity,
        targetValue: totalCost,
        targetWeight: weight,
      };
    })
    .filter(Boolean);
};

const normalizeTargetPositions = (rawTargets = []) => {
  const targets = extractTargetPositions(rawTargets);
  if (!targets.length) {
    return [];
  }

  let weightSum = targets.reduce((sum, target) => {
    return sum + (target.targetWeight && target.targetWeight > 0 ? target.targetWeight : 0);
  }, 0);

  if (weightSum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetWeight && target.targetWeight > 0 ? target.targetWeight / weightSum : 0,
    }));
  }

  const valueSum = targets.reduce((sum, target) => {
    return sum + (target.targetValue && target.targetValue > 0 ? target.targetValue : 0);
  }, 0);

  if (valueSum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetValue && target.targetValue > 0 ? target.targetValue / valueSum : 0,
    }));
  }

  const quantitySum = targets.reduce((sum, target) => {
    return sum + (target.targetQuantity && target.targetQuantity > 0 ? target.targetQuantity : 0);
  }, 0);

  if (quantitySum > 0) {
    return targets.map((target) => ({
      ...target,
      targetWeight: target.targetQuantity && target.targetQuantity > 0 ? target.targetQuantity / quantitySum : 0,
    }));
  }

  const equalWeight = 1 / targets.length;
  return targets.map((target) => ({
    ...target,
    targetWeight: equalWeight,
  }));
};

const estimateInitialInvestment = (targets = [], budget = null) => {
  const parsedBudget = toNumber(budget, null);
  if (parsedBudget && parsedBudget > 0) {
    return parsedBudget;
  }

  const valueSum = targets.reduce((sum, target) => {
    return sum + (target.targetValue && target.targetValue > 0 ? target.targetValue : 0);
  }, 0);

  if (valueSum > 0) {
    return valueSum;
  }

  return 0;
};



exports.createCollaborative = async (req, res) => {
  try {
    let input = req.body.collaborative;
    const UserID = req.body.userID;
    const rawStrategyName = typeof req.body.strategyName === 'string' ? req.body.strategyName.trim() : '';
    if (!rawStrategyName) {
      return res.status(400).json({
        status: "fail",
        message: "Please provide a name for this strategy.",
      });
    }
    const strategyName = rawStrategyName;
    const strategy = input;

    if (/Below is a trading[\s\S]*strategy does\?/.test(input)) {
      input = input.replace(/Below is a trading[\s\S]*strategy does\?/, "");
    }

    const parseJsonData = (fullMessage) => {
      if (!fullMessage) {
        throw new Error("Empty response from OpenAI");
      }

      const fenceMatch = fullMessage.match(/```json\s*([\s\S]*?)```/i);
      const payload = fenceMatch ? fenceMatch[1] : fullMessage;

      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) {
          return { positions: parsed, summary: "", decisions: [] };
        }
        if (Array.isArray(parsed?.positions)) {
          return {
            positions: parsed.positions,
            summary: typeof parsed.summary === "string" ? parsed.summary : "",
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions : []
          };
        }
        throw new Error("Response JSON missing positions array");
      } catch (error) {
        console.error("Failed to parse JSON from OpenAI response", error);
        throw new Error("Collaborative strategy response is not valid JSON");
      }
    };

    const existingStrategy = await Strategy.findOne({ name: strategyName });
    if (existingStrategy) {
      return res.status(409).json({
        status: "fail",
        message: `A strategy named "${strategyName}" already exists. Please choose another name.`,
      });
    }

    let parsedResult;
    try {
      parsedResult = await extractGPT(input).then(parseJsonData);
    } catch (error) {
      console.error('Error in extractGPT:', error);
      return res.status(400).json({
        status: "fail",
        message: error.message,
      });
    }

    const { positions, summary, decisions } = parsedResult;
    const recurrence = normalizeRecurrence(req.body?.recurrence);
    const cashLimitInput = toNumber(
      req.body?.cashLimit !== undefined ? req.body.cashLimit : req.body?.budget,
      null
    );

    if (!cashLimitInput || cashLimitInput <= 0) {
      return res.status(400).json({
        status: "fail",
        message: "Please provide a positive cash limit for the collaborative strategy.",
      });
    }

    const normalizedTargets = normalizeTargetPositions(positions);
    if (!normalizedTargets.length) {
      return res.status(400).json({
        status: "fail",
        message: "Unable to determine target positions for this strategy.",
      });
    }

    console.log('Strategy summary: ', summary || 'No summary provided.');
    console.log('Orders payload: ', JSON.stringify(positions, null, 2));
    if (decisions?.length) {
      console.log('Decision rationale:', JSON.stringify(decisions, null, 2));
    }

    const alpacaConfig = await getAlpacaConfig(UserID);
    console.log("config key done");

    const alpacaApi = new Alpaca(alpacaConfig);
    console.log("connected to alpaca");
    const account = await alpacaApi.getAccount();
    const accountCash = toNumber(account?.cash, 0);
    const planningBudget = Math.min(
      cashLimitInput,
      accountCash > 0 ? accountCash : cashLimitInput
    );

    if (!planningBudget || planningBudget <= 0) {
      return res.status(400).json({
        status: "fail",
        message: "Insufficient available cash to fund the collaborative strategy with the selected limit.",
      });
    }

    const dataKeys = alpacaConfig.getDataKeys ? alpacaConfig.getDataKeys() : null;
    const uniqueSymbols = Array.from(
      new Set(
        normalizedTargets
          .map((target) => target.symbol)
          .filter(Boolean)
      )
    );

    if (!uniqueSymbols.length) {
      return res.status(400).json({
        status: "fail",
        message: "No valid tickers found in the collaborative strategy.",
      });
    }

    const priceMap = {};

    if (dataKeys?.client && dataKeys?.apiUrl && dataKeys?.keyId && dataKeys?.secretKey) {
      await Promise.all(
        uniqueSymbols.map(async (symbol) => {
          try {
            const { data } = await dataKeys.client.get(
              `${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`,
              {
                headers: {
                  'APCA-API-KEY-ID': dataKeys.keyId,
                  'APCA-API-SECRET-KEY': dataKeys.secretKey,
                },
              }
            );
            const lastTradePrice = toNumber(data?.trade?.p, null);
            if (lastTradePrice && lastTradePrice > 0) {
              priceMap[symbol] = lastTradePrice;
            }
          } catch (error) {
            console.warn(`Failed to fetch latest price for ${symbol}:`, error.message);
          }
        })
      );
    }

    const sortedTargets = normalizedTargets
      .filter((target) => target.symbol && target.targetWeight > 0)
      .sort((a, b) => (b.targetWeight || 0) - (a.targetWeight || 0));

    const orderPlan = [];
    let plannedCost = 0;

    const resolveFallbackPrice = (target) => {
      const quantity = toNumber(target.targetQuantity, null);
      const value = toNumber(target.targetValue, null);
      if (quantity && quantity > 0 && value && value > 0) {
        return value / quantity;
      }
      return null;
    };

    for (const target of sortedTargets) {
      const symbol = target.symbol;
      const explicitPrice = toNumber(priceMap[symbol], null);
      const fallbackPrice = resolveFallbackPrice(target);
      const price = explicitPrice && explicitPrice > 0
        ? explicitPrice
        : (fallbackPrice && fallbackPrice > 0 ? fallbackPrice : null);

      if (!price || price <= 0) {
        console.warn(`Skipping ${symbol}; unable to determine a valid price.`);
        continue;
      }

      const desiredValue = planningBudget * target.targetWeight;
      let qty = Math.floor(desiredValue / price);

      const remainingBudget = planningBudget - plannedCost;
      if (qty * price > remainingBudget) {
        qty = Math.floor(remainingBudget / price);
      }

      if (qty <= 0 && remainingBudget >= price) {
        qty = 1;
      }

      if (qty <= 0) {
        continue;
      }

      const cost = qty * price;
      plannedCost += cost;
      orderPlan.push({
        symbol,
        qty,
        price,
        cost,
      });

      if (plannedCost >= planningBudget) {
        break;
      }
    }

    let remainingBudget = planningBudget - plannedCost;
    if (remainingBudget > 0 && orderPlan.length) {
      for (const plan of orderPlan) {
        if (remainingBudget < plan.price) {
          continue;
        }
        const additionalQty = Math.floor(remainingBudget / plan.price);
        if (additionalQty <= 0) {
          continue;
        }
        const additionalCost = additionalQty * plan.price;
        plan.qty += additionalQty;
        plan.cost += additionalCost;
        plannedCost += additionalCost;
        remainingBudget -= additionalCost;
        if (plannedCost >= planningBudget || remainingBudget <= 0) {
          break;
        }
      }
    }

    const finalizedPlan = orderPlan.filter((entry) => entry.qty > 0);
    if (!finalizedPlan.length) {
      return res.status(400).json({
        status: "fail",
        message: "Cash limit is too low to purchase any assets for this strategy.",
      });
    }

    plannedCost = finalizedPlan.reduce((sum, entry) => sum + entry.cost, 0);
    console.log(
      'Collaborative strategy order plan within cash limit:',
      finalizedPlan.map((entry) => ({ symbol: entry.symbol, qty: entry.qty, price: entry.price })),
      'Total estimated cost:',
      plannedCost.toFixed(2)
    );

    const executedTargetsRaw = finalizedPlan.map((entry) => ({
      symbol: entry.symbol,
      targetQuantity: entry.qty,
      targetValue: entry.cost,
      targetWeight: plannedCost > 0 ? entry.cost / plannedCost : 0,
    }));
    const executedTargets = normalizeTargetPositions(executedTargetsRaw);

    const orderPromises = finalizedPlan.map(({ symbol, qty }) => {
      return retry(() => {
        return axios({
          method: 'post',
          url: alpacaConfig.apiURL + '/v2/orders',
          headers: {
            'APCA-API-KEY-ID': alpacaConfig.keyId,
            'APCA-API-SECRET-KEY': alpacaConfig.secretKey
          },
          data: {
            symbol,
            qty,
            side: 'buy',
            type: 'market',
            time_in_force: 'gtc'
          }
        }).then((response) => {
          console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
          return { qty, symbol, orderID: response.data.client_order_id };
        });
      }, 5, 2000).catch((error) => {
        console.error(`Failed to place order for ${symbol}: ${error}`);
          return null;
      });
    });

    const orders = (await Promise.all(orderPromises)).filter(Boolean);
    const initialInvestmentEstimate = plannedCost;
    if (!orders.length) {
      console.error('Failed to place all orders.');
      return res.status(400).json({
        status: "fail",
        message: "Failed to place orders. Try again.",
      });
    }

    const portfolioRecord = await exports.addPortfolio(
      strategy,
      strategyName,
      orders,
      UserID,
      {
        budget: cashLimitInput,
        cashLimit: cashLimitInput,
        targetPositions: executedTargets,
        recurrence,
        initialInvestment: initialInvestmentEstimate,
      }
    );

    const schedule = portfolioRecord
      ? {
          recurrence: portfolioRecord.recurrence,
          nextRebalanceAt: portfolioRecord.nextRebalanceAt,
          lastRebalancedAt: portfolioRecord.lastRebalancedAt,
        }
      : null;

    return res.status(200).json({
      status: "success",
      orders,
      summary: summary || "",
      decisions: decisions || [],
      schedule,
    });
  } catch (error) {
    console.error(`Error in createCollaborative:`, error);
    return res.status(500).json({
      status: "fail",
      message: `Something unexpected happened: ${error.message}`,
    });
  }
};

 


  exports.deleteCollaborative = async (req, res) => {
    console.log('deleting strategy');
    try {
      // Get the strategy ID from the request parameters
      const strategyId = req.params.strategyId;
      const UserID = req.params.userId;
  
      console.log('strategyId', strategyId);
  
      // Find the strategy in the database
      const strategy = await Strategy.findOne({ strategy_id: strategyId });
  
      if (!strategy) {
        return res.status(404).json({
          status: "fail",
          message: "Strategy not found",
        });
      }
  
      // Find the portfolio in the database
      const portfolio = await Portfolio.findOne({ strategy_id: strategyId });
  
      if (!portfolio) {
        return res.status(404).json({
          status: "fail",
          message: "Portfolio not found",
        });
      }
  
      // Delete the strategy
      await Strategy.deleteOne({ strategy_id: strategyId })
      .catch(error => {
        console.error(`Error deleting strategy: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the strategy",
        });
      });
  
      // Delete the portfolio
      await Portfolio.deleteOne({ strategy_id: strategyId })
      .catch(error => {
        console.error(`Error deleting portfolio: ${error}`);
        return res.status(500).json({
          status: "fail",
          message: "An error occurred while deleting the portfolio",
        });
      });
  
      // Send a sell order for all the stocks in the portfolio
      const alpacaConfig = await getAlpacaConfig(UserID);
      const alpacaApi = new Alpaca(alpacaConfig);
  
      let sellOrderPromises = portfolio.stocks.map(stock => {
        return alpacaApi.createOrder({
          symbol: stock.symbol,
          qty: stock.quantity,
          side: 'sell',
          type: 'market',
          time_in_force: 'gtc'
        }).then((response) => {
          console.log(`Sell order of ${stock.quantity} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
          return { qty: stock.quantity, symbol: stock.symbol, orderID: response.client_order_id};
        }).catch((error) => {
          console.error(`Failed to place sell order for ${stock.symbol}: ${error}`)
          return null;
        });
      });
  
      Promise.all(sellOrderPromises).then(sellOrders => {
        // Filter out any null values
        sellOrders = sellOrders.filter(order => order !== null);
  
        // If all sell orders failed, return an error message
        if (sellOrders.length === 0) {
          console.error('Failed to place all sell orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place sell orders. Try again.",
          });
        }
  
        // If some sell orders were successful, return a success message
        return res.status(200).json({
          status: "success",
          message: "Strategy and portfolio deleted successfully, and sell orders placed.",
          sellOrders: sellOrders,
        });





        
      }).catch(error => {
        console.error(`Error: ${error}`);
        return res.status(400).json({
          status: "fail",
          message: `Something unexpected happened: ${error.message}`,
        });
      });
  
    } catch (error) {
      console.error(`Error deleting strategy and portfolio: ${error}`);
      return res.status(500).json({
        status: "fail",
        message: "An error occurred while deleting the strategy and portfolio",
      });
    }
  };



  //still it does not use all the budget it seems
 
 exports.enableAIFund = async (req, res) => {
    try {
        let budget = toNumber(req.body.budget, 0);
        const UserID = req.body.userID;
        const strategyName = req.body.strategyName;
        const strategy = "AiFund";
        const recurrence = normalizeRecurrence(req.body?.recurrence);

        const existingStrategy = await Strategy.findOne({ name: strategyName });
        if (existingStrategy) {
          return res.status(409).json({
            status: "fail",
            message: `The strategy "${strategyName}" already exists. You can manage it from the dashboard.`,
          });
        }
  
        // Scoring
        let scoreResults = require('../data/scoreResults.json');
        scoreResults.sort((a, b) => b.Score - a.Score); // Sort by score in descending order
        let topAssets = scoreResults.slice(0, 5); // Get the top 5 assets
  
        // Creating orders
        let orderList = topAssets.map(asset => {
          return {
            'Asset ticker': asset.Ticker,
            'Quantity': 0, // Quantity will be calculated later
            'Current Price': 0 // Current price will be updated later
          };
        });
  
        console.log('orderList', orderList);
  
        // Calculating investing amounts
        let totalScore = topAssets.reduce((total, asset) => total + asset.Score, 0);
        let remainingBudget = budget;
  
        const alpacaConfig = await getAlpacaConfig(UserID);
        console.log("config key done");
  
        for (let i = 0; i < orderList.length; i++) {
          let asset = orderList[i];
          let symbol = asset['Asset ticker'];
          let originalSymbol = symbol; // Save the original symbol for later use
  
          let currentPrice = 0;
  
          // Get the last price for the stock using the Alpaca API
          const alpacaUrl = `https://data.alpaca.markets/v2/stocks/${symbol}/quotes/latest`;
          const alpacaResponse = await Axios.get(alpacaUrl, {
            headers: {
              'APCA-API-KEY-ID': alpacaConfig.keyId,
              'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
            },
          });
          currentPrice = alpacaResponse.data.quote.ap;
          asset['Current Price'] = currentPrice; // Update the current price in the order list

  
          // If the current price is still 0, get the adjClose from the past day
          if (currentPrice === 0) {
  
            // Get the historical stock data for the given ticker from the Tiingo API
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 2);
            const year = startDate.getFullYear();
            const month = startDate.getMonth() + 1;
            const day = startDate.getDate();
  
            let url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
            let response;
            try {
              response = await Axios.get(url);
            } catch (error) {
              if (symbol.includes('.')) {
                symbol = symbol.replace('.', '-');
                url = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${year}-${month}-${day}&token=${process.env.TIINGO_API_KEY1}`;
                response = await Axios.get(url);
              } else {
                throw error;
              }
            }
            const data = response.data;
            currentPrice = data[data.length - 1].adjClose;
          }
  
          console.log(`Current price of ${symbol} is ${currentPrice}`);

          // Calculate the quantity based on the score of the asset
          let assetScore = topAssets.find(a => a.Ticker === originalSymbol).Score; // Use the original symbol here
          let allocatedBudget = (assetScore / totalScore) * budget;
          
          // Calculate the quantity to buy
          let quantity = Math.floor(allocatedBudget / currentPrice);
          
          // Update the remaining budget
          remainingBudget -= quantity * currentPrice;
          
          // Update the order list with the calculated quantity
          orderList[i]['Quantity'] = quantity;
          }
          
      // Sort the orderList by price in ascending order
      orderList.sort((a, b) => a['Current Price'] - b['Current Price']);

      // If there's remaining budget, distribute it to the assets again
      while (remainingBudget > 0) {
        let budgetUsed = false;
        for (let i = 0; i < orderList.length; i++) {
          let asset = orderList[i];
          let symbol = asset['Asset ticker'];
          let currentPrice = asset['Current Price'];

          // Calculate the quantity to buy with the remaining budget
          let quantity = Math.floor(remainingBudget / currentPrice);

          // If quantity is 0, continue to the next asset
          if (quantity === 0) continue;

          // Update the remaining budget
          remainingBudget -= quantity * currentPrice;

          // Update the order list with the additional quantity
          orderList[i]['Quantity'] += quantity;

          // Set budgetUsed to true
          budgetUsed = true;

          // If there's no remaining budget, break the loop
          if (remainingBudget <= 0) {
            break;
          }
        }

        // If no budget was used in a full loop through the orderList, break the while loop
        if (!budgetUsed) break;
      }

          
        
              const normalizedTargets = normalizeTargetPositions(
                orderList.map((asset) => ({
                  symbol: asset['Asset ticker'],
                  targetQuantity: asset['Quantity'],
                  targetValue: toNumber(asset['Quantity'], 0) * toNumber(asset['Current Price'], 0),
                }))
              );
              const initialInvestmentEstimate = estimateInitialInvestment(normalizedTargets, budget);

              // Send the orders to the trading platform
              console.log('Order: ', JSON.stringify(orderList, null, 2));
        
              // Send the orders to alpaca
              const orderPromises = orderList.map(asset => {
                const symbol = sanitizeSymbol(asset['Asset ticker']);
                const qty = Math.floor(asset['Quantity']);
        
                if (qty > 0) {
                  return retry(() => {
                    return axios({
                      method: 'post',
                      url: alpacaConfig.apiURL + '/v2/orders',
                      headers: {
                        'APCA-API-KEY-ID': alpacaConfig.keyId,
                        'APCA-API-SECRET-KEY': alpacaConfig.secretKey
                      },
                      data: {
                        symbol: symbol,
                        qty: qty,
                        side: 'buy',
                        type: 'market',
                        time_in_force: 'gtc'
                      }
                    }).then((response) => {
                      console.log(`Order of ${qty} shares for ${symbol} has been placed. Order ID: ${response.data.client_order_id}`);
                      return { qty: qty, symbol: symbol, orderID: response.data.client_order_id};
                    });
                  }, 5, 2000).catch((error) => {
                    console.error(`Failed to place order for ${symbol}: ${error}`)
                    return null;
                  })
                } else {
                  console.log(`Quantity for ${symbol} is ${qty}. Order not placed.`);
                  return null;
                }
        });

        const orders = (await Promise.all(orderPromises)).filter(Boolean);

        if (orders.length === 0) {
          console.error('Failed to place all orders.');
          return res.status(400).json({
            status: "fail",
            message: "Failed to place orders. Try again.",
          });
        }

        const portfolioRecord = await exports.addPortfolio(
          strategy,
          strategyName,
          orders,
          UserID,
          {
            budget,
            targetPositions: normalizedTargets,
            recurrence,
            initialInvestment: initialInvestmentEstimate,
          }
        );

        const schedule = portfolioRecord
          ? {
              recurrence: portfolioRecord.recurrence,
              nextRebalanceAt: portfolioRecord.nextRebalanceAt,
              lastRebalancedAt: portfolioRecord.lastRebalancedAt,
            }
          : null;

      return res.status(200).json({
        status: "success",
        orders,
        schedule,
      });
    } catch (error) {
      console.error(`Error in enableAIFund: ${error}`);
      await recordStrategyLog({
        strategyId: strategyName,
        userId: String(UserID || ''),
        strategyName,
        level: 'error',
        message: 'Failed to enable AI Fund strategy',
        details: { error: error.message },
      });
      return res.status(500).json({
        status: "fail",
        message: `Something unexpected happened: ${error.message}`,
      });
    }
  }




exports.disableAIFund = async (req, res) => {
      console.log('deleting strategy');
      try {
        // Get the strategy ID 
        const strategyId = "01";
        const UserID = req.params.userId;
    
        console.log('strategyId', strategyId);
    
        // Find the strategy in the database
        const strategy = await Strategy.findOne({ strategy_id: strategyId });
    
        if (!strategy) {
          return res.status(404).json({
            status: "fail",
            message: "Strategy not found",
          });
        }
    
        // Find the portfolio in the database
        const portfolio = await Portfolio.findOne({ strategy_id: strategyId });
    
        if (!portfolio) {
          return res.status(404).json({
            status: "fail",
            message: "Portfolio not found",
          });
        }
    
        // Delete the strategy
        await Strategy.deleteOne({ strategy_id: strategyId })
        .catch(error => {
          console.error(`Error deleting strategy: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the strategy",
          });
        });
    
        // Delete the portfolio
        await Portfolio.deleteOne({ strategy_id: strategyId })
        .catch(error => {
          console.error(`Error deleting portfolio: ${error}`);
          return res.status(500).json({
            status: "fail",
            message: "An error occurred while deleting the portfolio",
          });
        });
    
        // Send a sell order for all the stocks in the portfolio
        const alpacaConfig = await getAlpacaConfig(UserID);
        const alpacaApi = new Alpaca(alpacaConfig);
    
        let sellOrderPromises = portfolio.stocks.map(stock => {
          return alpacaApi.createOrder({
            symbol: stock.symbol,
            qty: stock.quantity,
            side: 'sell',
            type: 'market',
            time_in_force: 'gtc'
          }).then((response) => {
            console.log(`Sell order of ${stock.quantity} shares for ${stock.symbol} has been placed. Order ID: ${response.client_order_id}`);
            return { qty: stock.quantity, symbol: stock.symbol, orderID: response.client_order_id};
          }).catch((error) => {
            console.error(`Failed to place sell order for ${stock.symbol}: ${error}`)
            return null;
          });
        });
    
        Promise.all(sellOrderPromises).then(sellOrders => {
          // Filter out any null values
          sellOrders = sellOrders.filter(order => order !== null);
    
          // If all sell orders failed, return an error message
          if (sellOrders.length === 0) {
            console.error('Failed to place all sell orders.');
            return res.status(400).json({
              status: "fail",
              message: "Failed to place sell orders. Try again.",
            });
          }
    
          // If some sell orders were successful, return a success message
          return res.status(200).json({
            status: "success",
            message: "Strategy and portfolio deleted successfully, and sell orders placed.",
            sellOrders: sellOrders,
          });
  
  
  
  
  
          
        }).catch(error => {
          console.error(`Error: ${error}`);
          return res.status(400).json({
            status: "fail",
            message: `Something unexpected happened: ${error.message}`,
          });
        });
    
  } catch (error) {
    console.error(`Error deleting strategy and portfolio: ${error}`);
    return res.status(500).json({
      status: "fail",
      message: "An error occurred while deleting the strategy and portfolio",
    });
  }
};



exports.getStrategyLogs = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }

    const logs = await StrategyLog.find({
      strategy_id: strategyId,
      userId: String(userId),
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    return res.status(200).json({
      status: 'success',
      logs,
    });
  } catch (error) {
    console.error('Error fetching strategy logs:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to load strategy logs',
    });
  }
};

exports.updateStrategyRecurrence = async (req, res) => {
  try {
    const { userId, strategyId } = req.params;
    const { recurrence } = req.body || {};

    if (!recurrence) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is required.',
      });
    }

    if (!VALID_RECURRENCES.has(String(recurrence))) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is not supported.',
      });
    }

    if (req.user !== userId) {
      return res.status(403).json({
        status: 'fail',
        message: 'Credentials could not be validated.',
      });
    }

    const normalizedRecurrence = normalizeRecurrence(recurrence);
    if (!normalizedRecurrence) {
      return res.status(400).json({
        status: 'fail',
        message: 'Recurrence value is not supported.',
      });
    }

    const portfolio = await Portfolio.findOne({ strategy_id: strategyId, userId: String(userId) });
    if (!portfolio) {
      return res.status(404).json({
        status: 'fail',
        message: 'Portfolio not found for this strategy.',
      });
    }

    const strategy = await Strategy.findOne({ strategy_id: strategyId });

    const now = new Date();
    const nextRebalanceAt = computeNextRebalanceAt(normalizedRecurrence, now);

    portfolio.recurrence = normalizedRecurrence;
    portfolio.nextRebalanceAt = nextRebalanceAt;
    await portfolio.save();

    if (strategy) {
      strategy.recurrence = normalizedRecurrence;
      await strategy.save();
    }

    await recordStrategyLog({
      strategyId,
      userId: String(userId),
      strategyName: portfolio.name,
      message: 'Strategy frequency updated',
      details: {
        recurrence: normalizedRecurrence,
        nextRebalanceAt,
      },
    });

    return res.status(200).json({
      status: 'success',
      recurrence: normalizedRecurrence,
      nextRebalanceAt,
    });
  } catch (error) {
    console.error('Error updating strategy recurrence:', error.message);
    return res.status(500).json({
      status: 'fail',
      message: 'Failed to update recurrence',
    });
  }
};



exports.getPortfolios = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        status: 'fail',
        message: 'User ID is required',
      });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found',
      });
    }

    const alpacaConfig = await getAlpacaConfig(userId);
    if (!alpacaConfig?.hasValidKeys) {
      return res.status(403).json({
        status: 'fail',
        message: alpacaConfig?.error || 'Invalid Alpaca credentials',
      });
    }

    const tradingKeys = alpacaConfig.getTradingKeys();
    const dataKeys = alpacaConfig.getDataKeys();

    const [positionsResponse, accountResponse] = await Promise.all([
      tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/positions`, {
        headers: {
          'APCA-API-KEY-ID': tradingKeys.keyId,
          'APCA-API-SECRET-KEY': tradingKeys.secretKey,
        },
      }),
      tradingKeys.client.get(`${tradingKeys.apiUrl}/v2/account`, {
        headers: {
          'APCA-API-KEY-ID': tradingKeys.keyId,
          'APCA-API-SECRET-KEY': tradingKeys.secretKey,
        },
      }),
    ]);

    const accountCash = toNumber(accountResponse?.data?.cash, 0);
    const positions = Array.isArray(positionsResponse.data) ? positionsResponse.data : [];

    const positionMap = {};
    const priceCache = {};

    positions.forEach((position) => {
      const symbol = sanitizeSymbol(position.symbol);
      if (!symbol) {
        return;
      }
      positionMap[symbol] = position;
      const price = toNumber(position.current_price, toNumber(position.avg_entry_price, null));
      if (price) {
        priceCache[symbol] = price;
      }
    });

    const rawPortfolios = await Portfolio.find({
      userId: String(userId),
    }).lean();

    if (!rawPortfolios.length) {
      return res.json({
        status: 'success',
        portfolios: [],
        cash: accountCash,
      });
    }

    const symbolsToFetch = new Set();
    rawPortfolios.forEach((portfolio) => {
      (portfolio.stocks || []).forEach((stock) => {
        const symbol = sanitizeSymbol(stock.symbol);
        if (symbol && priceCache[symbol] == null) {
          symbolsToFetch.add(symbol);
        }
      });
      (portfolio.targetPositions || []).forEach((target) => {
        const symbol = sanitizeSymbol(target.symbol);
        if (symbol && priceCache[symbol] == null) {
          symbolsToFetch.add(symbol);
        }
      });
    });

    if (symbolsToFetch.size) {
      const headers = {
        'APCA-API-KEY-ID': dataKeys.keyId,
        'APCA-API-SECRET-KEY': dataKeys.secretKey,
      };
      await Promise.all(
        Array.from(symbolsToFetch).map(async (symbol) => {
          try {
            const { data } = await dataKeys.client.get(`${dataKeys.apiUrl}/v2/stocks/${symbol}/trades/latest`, {
              headers,
            });
            const price = toNumber(data?.trade?.p, null);
            if (price) {
              priceCache[symbol] = price;
            }
          } catch (error) {
            console.warn(`[Portfolios] Failed to fetch latest price for ${symbol}: ${error.message}`);
          }
        })
      );
    }

    const now = new Date();
    const enhancedPortfolios = rawPortfolios.map((portfolio) => {
      let normalizedTargets = normalizeTargetPositions(portfolio.targetPositions || []);
      if (!normalizedTargets.length) {
        normalizedTargets = normalizeTargetPositions(
          (portfolio.stocks || []).map((stock) => ({
            symbol: stock.symbol,
            targetQuantity: stock.quantity,
            targetValue: stock.avgCost && stock.quantity ? stock.avgCost * stock.quantity : null,
          }))
        );
      }

      const stocks = (portfolio.stocks || []).map((stock) => {
        const symbol = sanitizeSymbol(stock.symbol);
        const alpacaPosition = symbol ? positionMap[symbol] : null;

        const quantity = stock.quantity !== undefined && stock.quantity !== null
          ? toNumber(stock.quantity, 0)
          : alpacaPosition
          ? toNumber(alpacaPosition.qty, 0)
          : 0;

        const avgCost = stock.avgCost !== undefined && stock.avgCost !== null
          ? toNumber(stock.avgCost, null)
          : alpacaPosition
          ? toNumber(alpacaPosition.avg_entry_price, null)
          : null;

        const currentPrice = symbol && priceCache[symbol] !== undefined
          ? priceCache[symbol]
          : alpacaPosition
          ? toNumber(alpacaPosition.current_price, toNumber(alpacaPosition.avg_entry_price, null))
          : null;

        return {
          symbol,
          avgCost,
          quantity,
          currentPrice,
          orderID: stock.orderID || null,
          currentTotal: currentPrice !== null ? quantity * currentPrice : null,
        };
      });

      return {
        name: portfolio.name,
        strategy_id: portfolio.strategy_id,
        recurrence: portfolio.recurrence || 'daily',
        lastRebalancedAt: portfolio.lastRebalancedAt,
        nextRebalanceAt: portfolio.nextRebalanceAt,
        cashBuffer: toNumber(portfolio.cashBuffer, 0),
        initialInvestment: toNumber(portfolio.initialInvestment, 0),
        targetPositions: normalizedTargets,
        budget: toNumber(portfolio.budget, null),
        cashLimit: toNumber(portfolio.cashLimit, toNumber(portfolio.budget, null)),
        status: (() => {
          const next = portfolio.nextRebalanceAt ? new Date(portfolio.nextRebalanceAt) : null;
          const last = portfolio.lastRebalancedAt ? new Date(portfolio.lastRebalancedAt) : null;
          if (next && next <= now) {
            return 'pending';
          }
          if (last) {
            return 'running';
          }
          return 'scheduled';
        })(),
        stocks,
      };
    });

    return res.json({
      status: 'success',
      cash: accountCash,
      portfolios: enhancedPortfolios,
    });
  } catch (error) {
    console.error('Error in getPortfolios:', error.message);
    if (error.response) {
      console.error('API Response:', error.response.status, error.response.data);
    }
    return res.status(error.response?.status || 500).json({
      status: 'fail',
      message: 'Failed to fetch strategy portfolios',
      details: error.response?.data || error.message,
    });
  }
};



exports.addPortfolio = async (strategyinput, strategyName, orders, UserID, options = {}) => {
  console.log('strategyName', strategyName);
  console.log('orders', orders);
  console.log('UserID', UserID);

  const {
    budget = null,
    cashLimit = null,
    targetPositions = [],
    recurrence = 'daily',
    initialInvestment: initialInvestmentInput = null,
  } = options || {};
  const limitValue = toNumber(cashLimit, null) ?? toNumber(budget, null);

  let strategy_id;

  try {
    const normalizedRecurrence = normalizeRecurrence(recurrence);
    let targets = normalizeTargetPositions(targetPositions);
    if (!targets.length && Array.isArray(orders)) {
      targets = normalizeTargetPositions(orders);
    }

    const alpacaConfig = await getAlpacaConfig(UserID);
    const alpacaApi = new Alpaca(alpacaConfig);
    const clock = await alpacaApi.getClock();
    const now = new Date();

    if (strategyName === 'AI Fund') {
      strategy_id = '01';
    } else {
      strategy_id = crypto.randomBytes(16).toString('hex');
    }

    const strategy = new Strategy({
      name: strategyName,
      strategy: strategyinput,
      strategy_id,
      recurrence: normalizedRecurrence,
    });

    await strategy.save();
    console.log('Strategy ' + strategyName + ' has been created.');

    const initialInvestmentEstimate = initialInvestmentInput && initialInvestmentInput > 0
      ? initialInvestmentInput
      : estimateInitialInvestment(targets, limitValue);

    if (!clock.is_open) {
      console.log('Market is closed.');

      const portfolio = new Portfolio({
        userId: String(UserID),
        name: strategyName,
        strategy_id,
        recurrence: normalizedRecurrence,
        initialInvestment: initialInvestmentEstimate,
        cashBuffer: Math.max(0, toNumber(limitValue, 0) - (initialInvestmentEstimate || 0)),
        lastRebalancedAt: null,
        nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
        targetPositions: targets,
        budget: toNumber(limitValue, null),
        cashLimit: toNumber(limitValue, null),
        stocks: Array.isArray(orders)
          ? orders.map((order) => ({
              symbol: sanitizeSymbol(order.symbol),
              avgCost: null,
              quantity: toNumber(order.qty, 0),
              currentPrice: null,
              orderID: order.orderID,
            }))
          : [],
      });

      const savedPortfolio = await portfolio.save();
      await recordStrategyLog({
        strategyId: strategy_id,
        userId: String(UserID),
        strategyName,
        message: 'Strategy created (orders pending fill)',
        details: {
          recurrence: normalizedRecurrence,
          initialInvestment: initialInvestmentEstimate,
          cashLimit: toNumber(limitValue, null),
          orderCount: Array.isArray(orders) ? orders.length : 0,
        },
      });
      console.log('Portfolio for strategy ' + strategyName + ' has been created. Market is closed so the orders are not filled yet.');
      return savedPortfolio.toObject();
    }

    console.log('Market is open.');
    const numberOfOrders = Array.isArray(orders) ? orders.length : 0;

    const getOrders = async () => {
      const ordersResponse = await axios({
        method: 'get',
        url: alpacaConfig.apiURL + '/v2/orders',
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
        params: {
          limit: numberOfOrders,
          status: 'all',
          nested: true,
        },
      });

      const filledOrders = ordersResponse.data.filter((order) => order.filled_qty !== '0');
      if (!filledOrders || filledOrders.length !== numberOfOrders) {
        throw new Error('Not all orders are closed or filled yet.');
      }
      return filledOrders;
    };

    let ordersResponse;
    try {
      ordersResponse = await retry(getOrders, 5, 4000);
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }

    const stocks = [];
    let totalInvested = 0;

    ordersResponse.forEach((order) => {
      if (order.side === 'buy') {
        const avgPrice = toNumber(order.filled_avg_price, null);
        const filledQty = toNumber(order.filled_qty, 0);
        totalInvested += (avgPrice || 0) * filledQty;
        stocks.push({
          symbol: sanitizeSymbol(order.symbol),
          avgCost: avgPrice,
          quantity: filledQty,
          currentPrice: avgPrice,
          orderID: order.client_order_id,
        });
      }
    });

    const determinedInitialInvestment = totalInvested || initialInvestmentEstimate || 0;
    const cashBuffer = Math.max(0, toNumber(limitValue, 0) - determinedInitialInvestment);

    const portfolio = new Portfolio({
      userId: String(UserID),
      name: strategyName,
      strategy_id,
      recurrence: normalizedRecurrence,
      initialInvestment: determinedInitialInvestment,
      cashBuffer,
      lastRebalancedAt: now,
      nextRebalanceAt: computeNextRebalanceAt(normalizedRecurrence, now),
      targetPositions: targets,
      budget: toNumber(limitValue, null),
      cashLimit: toNumber(limitValue, null),
      stocks,
    });

    const savedPortfolio = await portfolio.save();
    await recordStrategyLog({
      strategyId: strategy_id,
      userId: String(UserID),
      strategyName,
      message: 'Strategy created',
      details: {
        recurrence: normalizedRecurrence,
        initialInvestment: determinedInitialInvestment,
        cashBuffer,
        cashLimit: toNumber(limitValue, null),
        orderCount: Array.isArray(orders) ? orders.length : 0,
      },
    });
    console.log('Portfolio for strategy ' + strategyName + ' has been created.');
    return savedPortfolio.toObject();
  } catch (error) {
    console.error('Error:', error);
    if (strategy_id) {
      await recordStrategyLog({
        strategyId: strategy_id,
        userId: String(UserID),
        strategyName,
        level: 'error',
        message: 'Failed to add portfolio',
        details: { error: error.message },
      });
    }
    throw error;
  }
};

//this is also in strategiesController can be put in utils 
//not exactly here it is symbol not ticker
const getPricesData = async (stocks, marketOpen, userId) => {
  try {
    const alpacaConfig = await getAlpacaConfig(userId);

    const promises = stocks.map(async (stock) => {
      // console.log('Stock ticker:', stock.symbol);

      let url;
      if (marketOpen) {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/trades/latest`;
      } else {
        url = `https://data.alpaca.markets/v2/stocks/${stock.symbol}/bars?timeframe=1D&limit=1`;
      }

      const response = await Axios.get(url, {
        headers: {
          'APCA-API-KEY-ID': alpacaConfig.keyId,
          'APCA-API-SECRET-KEY': alpacaConfig.secretKey,
        },
      });

      // console.log("response.data: ",response.data);
      // console.log("response.data.quote.ap: ",response.data.quote.ap);
      // console.log("response.data.trade.p: ",response.data.trade.p);



      const currentPrice = marketOpen ? response.data.trade.p : response.data.bars.c 

      const date = marketOpen ? response.data.trade.t : response.data.bars.t;


      const alpacaApi = new Alpaca(alpacaConfig);

      const asset = await alpacaApi.getAsset(stock.symbol);
      const assetName = asset.name;
      

      return {
        ticker: stock.symbol,
        date: date,
        adjClose: currentPrice,
        name: assetName, 

      };
    });

    return Promise.all(promises);
  } catch (error) {
    return [];
  }
};


exports.getStrategies = async (req, res) => {
  try {
    if (req.user !== req.params.userId) {
      return res.status(200).json({
        status: "fail",
        message: "Credentials couldn't be validated.",
      });
    }

    const strategies = await Strategy.find();

    return res.status(200).json({
      status: "success",
      strategies: strategies
    });

  } catch (error) {
    console.error('Error fetching strategies:', error);
    return res.status(200).json({
      status: "fail",
      message: "Something unexpected happened.",
    });
  }
};



exports.getNewsHeadlines = async (req, res) => {
  const ticker = req.body.ticker;
  const period = req.body.period;

  const python = spawn('python3', ['./scripts/news.py', '--ticker', ticker, '--period', period]);

  let python_output = "";
  let python_log = "";

  const pythonPromise = new Promise((resolve, reject) => {
      python.stdout.on('data', (data) => {
          python_output += data.toString();
      });

      python.stderr.on('data', (data) => {
          python_log += data.toString();
      });

      python.on('close', (code) => {
          if (code !== 0) {
              console.log(`Python script exited with code ${code}`);
              reject(`Python script exited with code ${code}`);
          } else {
              resolve(python_output);
          }
      });
  });

  try {
      const python_output = await pythonPromise;
      console.log('Python output:', python_output);

      let newsData;
      try {
          newsData = JSON.parse(python_output);
          console.log('newsData:', newsData);

      } catch (err) {
          console.error(`Error parsing JSON in nodejs: ${err}`);
          console.error(`Invalid  JSON in nodejs: ${python_output}`);
          newsData = [];
      }

      const newsHeadlines = newsData.map(news => news["title"]);

      const stockKeywords = ["stock", "jumped", "intraday", "pre-market", "uptrend", "position", "increased", "gains", "loss", "up", "down", "rise", "fall", "bullish", "bearish", "nasdaq", "nyse", "percent", "%"];

      for (const news of newsData) {
          const lowerCaseTitle = news.title.toLowerCase();
          if (stockKeywords.some(keyword => lowerCaseTitle.includes(keyword))) {
              continue;
          }

          const existingNews = await News.find({ "Stock name": ticker, Date: news.date }).catch(err => {
              console.error('Error finding news:', err);
              throw err;
          });

          let isSimilar = false;
          for (const existing of existingNews) {
              const similarity = 1 - distance(existing["News headline"], news.title) / Math.max(existing["News headline"].length, news.title.length);
              if (similarity > 0.6) {
                  isSimilar = true;
                  break;
              }
          }

          if (!isSimilar) {
              const newNews = new News({
                  newsId: news.id,
                  "News headline": news.title,
                  Date: news.date,
                  Ticker: news.ticker,
                  "Stock name": ticker, 
                  Source: news.source,
              });
              try {
                  await newNews.save();
                  console.log(`Saved: ${newNews["News headline"]}`);
              } catch (err) {
                  console.log('Error saving news: ', err);
              }
          }
      }
      res.send(newsHeadlines);
  } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
  }
};
exports.getScoreHeadlines = async (req, res) => {
  try {
    const newsData = await News.find({});
    const newsDataJson = JSON.stringify(newsData);
    const inputFilePath = './data/newsData.json';
    const outputFilePath = './data/sentimentResults.json';
    const output2FilePath = './data/scoreResults.json';

    fs.writeFileSync(inputFilePath, newsDataJson);

    const python = spawn('python3', ['-u', './scripts/sentiment_claude5.py', inputFilePath, outputFilePath, output2FilePath]);

    python.stdout.on('data', (data) => {
      const message = data.toString();
      if (message.trim() !== '') {
        console.log(message);
      }
    });

    python.stderr.on('data', (data) => {
      console.error('Python error:', data.toString());
    });

    const pythonPromise = new Promise((resolve, reject) => {
      python.on('close', (code) => {
        if (code !== 0) {
          console.log(`Python script exited with code ${code}`);
          reject(`Python script exited with code ${code}`);
        } else {
          resolve();
        }
      });
    });

    try {
      await pythonPromise;
      res.send('Sentiment analysis completed successfully');
    } catch (err) {
      console.error('Error:', err);
      res.status(500).send(err);
    }
  } catch (err) {
    console.error('Error in getScoreHeadlines:', err);
    res.status(500).send('Error in getScoreHeadlines');
  }
};



exports.testPython = async (req, res) => {
  console.log('testPython called');
  const { spawn } = require('child_process');
  let input = req.body.input;

  const runPythonScript = async (input) => {
    return new Promise((resolve, reject) => {
      let python_process = spawn('python3', ['scripts/test.py', input]);
      let python_output = "";

      python_process.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
        python_output += data.toString();
      });

      python_process.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });

      python_process.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        resolve(python_output);
      });
    });
  }

  const getPython = async (input) => {
    let python_output = await runPythonScript(input);
    console.log('python_output:'+'\n\n'+python_output);
    return python_output.toString();
  }

  try {
    let result = await getPython(input);
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: 'An error occurred while running the Python script.' });
  }
};



// // Mock the Alpaca client when market is closed:

// const Mock = require('jest-mock');
// const Alpaca = Mock.fn(() => ({
//   getClock: Mock.fn(() => Promise.resolve({ is_open: true, next_open: '2023-05-14T13:30:00Z' })),
//   createOrder: Mock.fn(({ symbol, qty, side, type, time_in_force }, { price = 999 } = {}) => {
//     return Promise.resolve({ id: 'mock_order_id', status: 'accepted', price });
//   }),  
//   getPositions: Mock.fn(() => Promise.resolve([])),
// }));



// // Debugging function to log all axios requests as curl commands
// axios.interceptors.request.use((request) => {
//   let data = request.data ? JSON.stringify(request.data) : '';
//   let headers = '';
//   for (let header in request.headers) {
//     headers += `-H '${header}: ${request.headers[header]}' `;
//   }

//   let params = '';
//   if (request.params) {
//     params = Object.keys(request.params)
//       .map(key => `${key}=${encodeURIComponent(request.params[key])}`)
//       .join('&');
//   }

//   console.log(`curl -X ${request.method.toUpperCase()} '${request.url}${params ? `?${params}` : ''}' ${headers}${data ? ` -d '${data}'` : ''}` + '\n');
//   return request;
// });

function retry(fn, retriesLeft = 5, interval = 1000) {
  return new Promise((resolve, reject) => {
    fn().then(resolve)
      .catch((error) => {
        setTimeout(() => {
          if (retriesLeft === 1) {
            reject(error);
          } else {
            console.log(`Retrying... attempts left: ${retriesLeft - 1}`);
            retry(fn, retriesLeft - 1, interval).then(resolve, reject);
          }
        }, interval);
      });
  });
}
