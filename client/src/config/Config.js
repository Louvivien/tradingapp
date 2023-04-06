const config = {};

if (process.env.NODE_ENV === 'production') {
  config.base_url = process.env.REACT_APP_BASE_URL_PROD;
} else {
  config.base_url = process.env.REACT_APP_BASE_URL_DEV;
}

export default config;
