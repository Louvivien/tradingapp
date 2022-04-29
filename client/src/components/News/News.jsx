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
} from "@material-ui/core";
import { makeStyles } from "@material-ui/core/styles";
import Skeleton from "@material-ui/lab/Skeleton";
import Axios from "axios";
import config from "../../config/Config";

const useStyles = makeStyles((theme) => ({
  appBarSpacer: theme.mixins.toolbar,
  icon: {
    marginRight: theme.spacing(2),
  },
  cardGrid: {
    paddingTop: theme.spacing(8),
    paddingBottom: theme.spacing(8),
  },
  card: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },
  cardMedia: {
    paddingTop: "56.25%", // 16:9
  },
  cardContent: {
    flexGrow: 1,
  },
}));

const LoadingCards = ({ loading }) => {
  return (
    <div>
      <Typography gutterBottom align="center">
        {loading}
      </Typography>
      <br />
      <Grid container spacing={4}>
        {Array.from(new Array(6)).map((item, index) => (
          <Grid item key={index} xs={12} sm={6} md={4}>
            <Box key={index} width={210} marginRight={0.5}>
              <Skeleton variant="rect" width={300} height={200} />

              <Box pt={0.5}>
                <Skeleton />
                <Skeleton width="60%" />
              </Box>
            </Box>
          </Grid>
        ))}
      </Grid>
    </div>
  );
};

const NewsCards = ({ cards, classes }) => {
  return (
    <Grid container spacing={4}>
      {cards.map((card) => (
        <Grid item key={card.id} xs={12} sm={6} md={4}>
          <Card className={classes.card}>
            <Link href={card.url} target="_blank" rel="noopener noreferrer">
              <CardMedia
                className={classes.cardMedia}
                image={card.image}
                title={card.headline}
              />
            </Link>
            <CardContent className={classes.cardContent}>
              <Typography gutterBottom variant="h6" component="h4">
                {card.headline}
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      ))}
    </Grid>
  );
};

const News = () => {
  const classes = useStyles();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState("Loading...");

  useEffect(() => {
    const getCards = async () => {
      const url = config.base_url + "/api/news";
      const response = await Axios.get(url);
      if (response.data.status === "success" && response.data.data.length > 0) {
        const newsCards = response.data.data.slice(0, 9);
        setCards(newsCards);
      } else {
        setLoading(
          "Sorry, we couldn't load any articles from our provider. Please try again later!"
        );
      }
    };

    getCards();
  }, []);

  return (
    <Container className={classes.cardGrid}>
      {cards.length === 0 ? (
        <LoadingCards loading={loading} />
      ) : (
        <NewsCards cards={cards} classes={classes} />
      )}
    </Container>
  );
};

export default News;
