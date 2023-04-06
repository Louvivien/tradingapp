const config = {};

console.log("NODE_ENV:", process.env.NODE_ENV);


if (process.env.NODE_ENV === 'production') {
  config.base_url = 'https://tradingapp-divp.onrender.com';
} else {
  config.base_url = 'http://localhost:5000';
}

export default config;
