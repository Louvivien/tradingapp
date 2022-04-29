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
} from "@material-ui/core";
import { motion } from "framer-motion";
import CloseIcon from "@material-ui/icons/Close";
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
  const [activateSafetyButton, setActiveSafetyButton] = useState(false);

  const handleClick = () => {
    setSettingsOpen(false);
  };

  const handleResetOn = () => {
    setActiveSafetyButton(true);
  };

  const handleResetOff = () => {
    setActiveSafetyButton(false);
  };

  const resetAccount = async (e) => {
    e.preventDefault();

    const headers = {
      "x-auth-token": userData.token,
    };

    const url = config.base_url + `/api/stock/${userData.user.id}`;
    const response = await Axios.delete(url, {
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
            </form>
            <br />
            <Box display="flex" justifyContent="center">
              <Button
                type="submit"
                variant="contained"
                color="primary"
                className={styles.reset}
                onClick={handleResetOn}
              >
                Reset My Account
              </Button>
            </Box>
            {activateSafetyButton && (
              <div>
                <Typography component="p" variant="caption" align="center">
                  This is a permanent change. If you are sure press Reset.
                </Typography>
                <Box display="flex" justifyContent="center">
                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    className={styles.reset}
                    onClick={resetAccount}
                  >
                    Reset
                  </Button>
                  <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    className={styles.confirm}
                    onClick={handleResetOff}
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
