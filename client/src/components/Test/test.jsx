import React, { useState, useContext } from 'react';
import Layout from '../Template/Layout';
import { TextField, Button, Box } from '@mui/material';
import UserContext from '../../context/UserContext';
import Axios from 'axios';
import config from '../../config/Config';

const Test = () => {
  const { userData } = useContext(UserContext);
  const [ticker, setTicker] = useState('');
  const [period, setPeriod] = useState('');
  const [newsHeadlines, setNewsHeadlines] = useState([]);

  const fetchNews = async () => {
    try {
      const url = config.base_url + `/api/strategies/news/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.post(url, { ticker, period }, { headers });

      setNewsHeadlines(response.data.headlines);
      console.log("News Headlines: ", response.data.headlines);
    } catch (error) {
      console.error('Error fetching news:', error);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    fetchNews();
  };

  return (
    <Layout>
      <Box sx={{ mt: 10, ml: 3 }}>
        <h1>Fetch News Headlines</h1>
        
        <form onSubmit={handleSubmit}>
          <TextField
            id="ticker"
            label="Ticker"
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            variant="outlined"
            fullWidth
            margin="normal"
          />
          <TextField
            id="period"
            label="Period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            variant="outlined"
            fullWidth
            margin="normal"
          />
          <Button variant="contained" color="primary" type="submit">
            Submit
          </Button>
          <div 
            style={{
              marginTop: '16px',
              padding: '18.5px 14px',
              border: '1px solid #ced4da',
              borderRadius: '4px',
              fontFamily: '"Roboto", "Helvetica", "Arial", sans-serif',
              fontSize: '1rem',
              lineHeight: '1.1876em',
              overflowWrap: 'break-word',
              wordWrap: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {newsHeadlines.map((headline, index) => (
              <p key={index}>{headline}</p>
            ))}
          </div>
        </form>
      </Box>
    </Layout>
  );
};

export default Test;
