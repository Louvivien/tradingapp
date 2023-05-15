import React, { useState, useEffect } from "react";
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
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState("Loading...");
  const [strategy, setStrategy] = useState("");
  const [responseReceived, setResponseReceived] = useState(false);

  useEffect(() => {
    const getCards = async () => {
      // your existing code here
    };

    getCards();
  }, []);

  const handleStrategySubmit = async () => {
    // make your POST request here
    // on successful response, set responseReceived to true
    // const response = await Axios.post(url, { strategy });
    // if (response.status === 200) {
    //   setResponseReceived(true);
    // }
  };

  return (
    <Container sx={{ pt: 8, pb: 8 }}>
      <Typography variant="subtitle1">Add a trading strategy for automated trading</Typography>

      <br />
      <br />


      <FixedHeightPaper>
      <Box>
        <Title>Composer strategy</Title>
                <Typography color="textSecondary" align="left">Add a Composer symphony</Typography>
        <Typography variant="body1" size="small">
          Here you can copy paste a strategy from Composer. Open a symphony in Composer, edit it, under the Saved button, click on Copy ChatGPT prompt and copy past it in the below field
        </Typography>

        {!responseReceived ? (
          <>
            <TextField
              multiline
              rows={4}
              variant="outlined"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              fullWidth
              margin="normal"
            />
            <Button variant="contained" color="primary" onClick={handleStrategySubmit}>
              Create this strategy
            </Button>
          </>
        ) : (
          <Typography variant="h6">Strategy successfully added</Typography>
        )}
      </Box>
      </FixedHeightPaper>

    </Container>
  );
};

export default Strategies;
