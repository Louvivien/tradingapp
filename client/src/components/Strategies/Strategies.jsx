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
} from "@mui/material";
import { styled } from "@mui/system";
import Skeleton from "@mui/lab/Skeleton";
import Axios from "axios";
import config from "../../config/Config";


const Strategies = () => {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState("Loading...");

  useEffect(() => {
    const getCards = async () => {
      // const url = config.base_url + "/api/news";
      // const response = await Axios.get(url);
      // if (response.data.status === "success" && response.data.data.length > 0) {
      //   const newsCards = response.data.data.slice(0, 9);
      //   setCards(newsCards);
      // } else {
      //   setLoading(
      //     "Sorry, we couldn't load any articles from our provider. Please try again later!"
      //   );
      // }
    };

    getCards();
  }, []);

  return (
    <Container sx={{ pt: 8, pb: 8 }}>
      {/* {cards.length === 0 ? (
        <LoadingCards loading={loading} />
      ) : (
        <NewsCards cards={cards} />
      )} */}
    </Container>
  );
};

export default Strategies;
