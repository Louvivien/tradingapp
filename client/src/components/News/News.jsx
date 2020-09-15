import React, { useState, useEffect } from "react";
import {
  Typography,
  Container,
  Grid,
  Card,
  CardMedia,
  CardContent,
  Link,
} from "@material-ui/core";
import { makeStyles } from "@material-ui/core/styles";
import Axios from "axios";

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

const News = () => {
  const classes = useStyles();
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState("Loading...");

  useEffect(() => {
    const getCards = async () => {
      const url = "http://127.0.0.1:5000/api/news";
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
      {cards.length === 0 && <Typography>{loading}</Typography>}
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
    </Container>
  );
};

export default News;
