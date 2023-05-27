import React, { useState, useEffect, useContext } from 'react';
import Layout from '../Template/Layout';
import { TextField, Button, Box } from '@mui/material';
import UserContext from '../../context/UserContext';
import Axios from 'axios';
import config from '../../config/Config';

const Test = () => {
  const { userData } = useContext(UserContext);
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');

  const testPython = async () => {
    try {
      const url = config.base_url + `/api/strategies/testpython/${userData.user.id}`;
      const headers = {
        "x-auth-token": userData.token,
      };

      const response = await Axios.post(url, { input }, { headers });

      if (response.data.status === "success") {
        setOutput(response.data.python);
        console.log("Python ", response.data.python);
      }
    } catch (error) {
      console.error('Error fetching python:', error);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    testPython();
  };

  return (
    <Layout>
      <Box sx={{ mt: 10, ml: 3 }}>
        <h1>This is the Test Page</h1>
        <form onSubmit={handleSubmit}>
          <TextField
            id="input1"
            label="Input 1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            variant="outlined"
            fullWidth
            margin="normal"
          />
          <Button variant="contained" color="primary" type="submit">
            Submit
          </Button>
          <TextField
            id="output1"
            label="Output 1"
            value={output}
            variant="outlined"
            fullWidth
            margin="normal"
            InputProps={{
              readOnly: true,
            }}
          />
        </form>
      </Box>
    </Layout>
  );
};

export default Test;
