import React, { useState, useContext, useEffect } from "react";
import UserContext from "../../context/UserContext";
import {
  Typography,
  Container,
  Grid,
  Card,
  CardMedia,
  CardContent,
  Link,
  Box,
  TextField,
  Paper,
  Button
} from "@mui/material";
import { styled } from "@mui/system";
import Skeleton from "@mui/lab/Skeleton";
import Axios from "axios";
import config from "../../config/Config";
import Title from "../Template/Title.jsx";
import styles from "./Strategies.module.css";



const StyledPaper = styled(Paper)(({ theme }) => ({
  padding: theme.spacing(2),
  display: "flex",
  overflow: "auto",
  flexDirection: "column",
}));



const FixedHeightPaper = styled(StyledPaper)({
  height: 350,
});


const Strategies = () => {
  const [collaborative, setcollaborative] = useState("");
  const [responseReceived, setResponseReceived] = useState(false);
  const { userData, setUserData } = useContext(UserContext);
  const [output, setOutput] = useState(""); 
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);



  const handlecollaborativeSubmit = async (e) => {
    setLoading(true);


    const headers = {
      "x-auth-token": userData.token,
    };

    const prompt = {collaborative};
    const userID = userData.user.id;
    const url = config.base_url + "/api/strategies/collaborative/";

    try {
      const response = await Axios.post(url, {collaborative, userID}, {headers});
    
      if (response.status === 200) {
        if (response.data.status === "success") {
          setResponseReceived(true);
          setOutput(response.data.orders); 
          console.log(response);
        } else {
          setError(response.data.message);
        }
      }
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
    



};


  return (
    <Container sx={{ pt: 8, pb: 8 }}>
      <Typography variant="subtitle1">Add a trading strategy for automated trading</Typography>

      <br />
      <br />


      <FixedHeightPaper>
      <Box>
        <Title>Collaborative strategy</Title>
                <Typography color="textSecondary" align="left">Add a collaborative strategy</Typography>





          {loading ? (
            <div> 
            <br />
            <br />
              <div>Loading...</div>
            </div>  
          ) : responseReceived ? (
            <div>
            <br />
            <br />
              <Typography variant="h6">Strategy successfully added. Here are the orders:</Typography>
              {output.map((order, index) => (
                <Typography key={index} variant="body2">
                  Quantity: {order.qty}, Symbol: {order.symbol}
                </Typography>
              ))}
            </div>
          ) : error ? (
            <div> 
          <br />
          <br />
            <div style={{color: 'red'}}>Error: {error}</div>

            </div>  

          ) : (

          <div>
            <Typography variant="body1" size="small">
            Here you can copy paste a strategy from a collaborative source
          </Typography>
            
            <>
            <TextField
              multiline
              rows={4}
              variant="outlined"
              value={collaborative}
              onChange={(e) => setcollaborative(e.target.value)}
              fullWidth
              margin="normal"
            />
            <Button variant="contained" color="primary" className={styles.submit} onClick={handlecollaborativeSubmit}>
              Create this strategy
            </Button>
          </>
          </div>

          )}

      </Box>
      </FixedHeightPaper>

    </Container>
  );
};

export default Strategies;
