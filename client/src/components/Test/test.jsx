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
      console.log(response.data);

      setNewsHeadlines(response.data);
      console.log("Headlines added to the database");
    } catch (error) {
      console.error('Error fetching news:', error);
    }
  };

  const fetchScores = async () => {
    try {
      const url = config.base_url + `/api/strategies/score/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      await Axios.get(url, { headers });

      console.log("Scores calculated");
    } catch (error) {
      console.error('Error fetching scores:', error);
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
            Get News
          </Button>
          <Button variant="contained" color="secondary" onClick={fetchScores} style={{ marginLeft: '10px' }}>
            Get Scores
          </Button>
          <div>
            {newsHeadlines && newsHeadlines.map((headline, index) => (
              <p key={index}>{headline}</p>
            ))}
          </div>
        </form>
      </Box>
    </Layout>
  );
};

export default Test;
