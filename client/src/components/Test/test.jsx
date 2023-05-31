import React, { useState, useContext } from 'react';
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

      setOutput(response.data);
      console.log("Python ", response.data);
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
        <h1>Test your python script</h1>
        
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
            {output}
          </div>
        </form>
      </Box>
    </Layout>
  );
};

export default Test;
