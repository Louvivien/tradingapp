import React, { useState, useContext } from "react";
import UserContext from "../../context/UserContext";
import styles from "./PageTemplate.module.css";
import {
  Typography,
  IconButton,
  Box,
  Button,
  TextField,
  Container,
  Grid,
  Card,
  CardHeader,
  CardContent,
} from "@mui/material";
import { motion } from "framer-motion";
import CloseIcon from "@mui/icons-material/Close";
import Axios from "axios";
import config from "../../config/Config";

const SettingsModal = ({ setSettingsOpen }) => {
  return (
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      id="backdrop"
    >
      <Container>
        <motion.div animate={{ opacity: 1, y: -20 }}>
          <SettingsModalContent setSettingsOpen={setSettingsOpen} />
        </motion.div>
      </Container>
    </motion.div>
  );
};

const SettingsModalContent = ({ setSettingsOpen }) => {
  const { userData, setUserData } = useContext(UserContext);
  const [ALPACA_API_KEY_ID, setApiKeyId] = useState(userData.user.ALPACA_API_KEY_ID);
  const [ALPACA_API_SECRET_KEY, setApiSecretKey] = useState(userData.user.ALPACA_API_SECRET_KEY);
  const [activateSafetyButton, setActiveSafetyButton] = useState(false);

  

  
  const handleApiKeyChange = (event) => {
    console.log(event.target.value);
    setApiKeyId(event.target.value);
  }  

  const handleApiSecretKeyChange = (event) => {
    console.log(event.target.value);
    setApiSecretKey(event.target.value);
};

  const handleClick = () => {
    setSettingsOpen(false);
  };

  const handleEditOn = () => {
    setActiveSafetyButton(true);
  };

  const handleEditOff = () => {
    setActiveSafetyButton(false);
  };

  const editAccount = async (e) => {
    e.preventDefault();

    const headers = {
      "x-auth-token": userData.token,
    };

    const keys = {
      ALPACA_API_KEY_ID: ALPACA_API_KEY_ID,
      ALPACA_API_SECRET_KEY: ALPACA_API_SECRET_KEY,
    };

    const url = config.base_url + `/api/stock/${userData.user.id}`;
    const response = await Axios.post(url, keys,{
      headers,
    });

    if (response.data.status === "success") {
      setUserData({
        token: userData.token,
        user: response.data.user,
      });
      window.location.reload();
    }
  };

  return (
    <Grid
      container
      spacing={0}
      direction="column"
      alignItems="center"
      justify="center"
      style={{ minHeight: "100vh" }}
    >
      <Box width="60vh" boxShadow={1}>
        <Card>
          <CardHeader
            action={
              <IconButton aria-label="Close" onClick={handleClick}>
                <CloseIcon />
              </IconButton>
            }
          />
          <CardContent>
            <Typography component="h1" variant="h6" align="center">
              Settings
            </Typography>
            <form className={styles.form} onSubmit={(e) => e.preventDefault()}>
              <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                disabled
                id="Username"
                label="Username"
                name="Username"
                autoComplete="Username"
                value={userData.user.username}
              />
              <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                disabled
                id="balance"
                label="Cash Balance"
                name="balance"
                autoComplete="balance"
                value={userData.user.balance}
              />
               <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                id="ALPACA_API_KEY_ID"
                label="ALPACA_API_KEY_ID"
                name="ALPACA_API_KEY_ID"
                autoComplete="ALPACA_API_KEY_ID"
                value={ALPACA_API_KEY_ID}
                onChange={handleApiKeyChange}

                />
              <TextField
                variant="outlined"
                margin="normal"
                fullWidth
                id="ALPACA_API_SECRET_KEY"
                label="ALPACA_API_SECRET_KEY"
                name="ALPACA_API_SECRET_KEY"
                autoComplete="ALPACA_API_SECRET_KEY"
                value={ALPACA_API_SECRET_KEY}
                onChange={handleApiSecretKeyChange}

                />
            </form>
            <br />
            <Box display="flex" justifyContent="center">
              <Button
                type="submit"
                variant="contained"
                color="primary"
                className={styles.reset}
                onClick={handleEditOn}
              >
                Edit My Account
              </Button>
            </Box>
            {activateSafetyButton && (
              <div>
                <Typography component="p" variant="caption" align="center">
                  This is a permanent change. If you are sure press Edit.
                </Typography>
                <Box display="flex" justifyContent="center">
                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    className={styles.reset}
                    onClick={editAccount}
                  >
                    Edit
                  </Button>
                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    className={styles.confirm}
                    onClick={handleEditOff}
                  >
                    Cancel
                  </Button>
                </Box>
              </div>
            )}

            <br />
            <br />
          </CardContent>
        </Card>
      </Box>
    </Grid>
  );
};

export default SettingsModal;
