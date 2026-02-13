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
  Divider,
} from "@mui/material";
import { motion } from "framer-motion";
import CloseIcon from "@mui/icons-material/Close";
import Axios from "axios";
import config from "../../config/Config";
import { copyTextToClipboard } from "../../utils/aiportfolioIntegration";

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
  const [ALPACA_API_KEY_ID, setApiKeyId] = useState("");
  const [ALPACA_API_SECRET_KEY, setApiSecretKey] = useState("");
  const [activateSafetyButton, setActiveSafetyButton] = useState(false);
  const [showJwt, setShowJwt] = useState(false);
  const [jwtCopied, setJwtCopied] = useState(false);
  const [userIdCopied, setUserIdCopied] = useState(false);

  const alpacaKeysPresent = Boolean(userData?.user?.alpacaKeysPresent);
  const alpacaKeyIdMasked = userData?.user?.alpacaKeyIdMasked || null;

  const handleApiKeyChange = (event) => {
    setApiKeyId(event.target.value);
  };

  const handleApiSecretKeyChange = (event) => {
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

  const copyWithFallback = async (value, setFlag) => {
    const text = String(value || "");
    if (!text) {
      return;
    }
    const ok = await copyTextToClipboard(text);
    if (!ok) {
      // Last-resort fallback that still lets the user copy.
      window.prompt("Copy this value:", text);
      return;
    }
    setFlag(true);
    setTimeout(() => setFlag(false), 2000);
  };

  return (
    <Grid
      container
      spacing={0}
      direction="column"
      alignItems="center"
      justify="center"
      style={{ minHeight: "100vh", marginTop: "95px" }} 
      >
      <Grid item xs={12} sm={8} md={6} lg={4}>
        <Box boxShadow={1}>
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

                <Divider sx={{ my: 2 }} />
                <Typography component="h2" variant="subtitle1" align="center">
                  AI Portfolio Integration
                </Typography>
                <TextField
                  variant="outlined"
                  margin="normal"
                  fullWidth
                  InputProps={{ readOnly: true }}
                  id="tradingapp_user_id"
                  label="User ID"
                  value={userData.user.id || ""}
                />
                <TextField
                  variant="outlined"
                  margin="normal"
                  fullWidth
                  InputProps={{ readOnly: true }}
                  id="tradingapp_base_url"
                  label="TradingApp base URL"
                  value={config.base_url || ""}
                />
                <TextField
                  variant="outlined"
                  margin="normal"
                  fullWidth
                  InputProps={{ readOnly: true }}
                  id="tradingapp_jwt"
                  label="JWT (x-auth-token)"
                  type={showJwt ? "text" : "password"}
                  value={userData.token || ""}
                />
                <Box display="flex" justifyContent="center" gap={1} flexWrap="wrap" sx={{ mt: 1 }}>
                  <Button variant="outlined" onClick={() => setShowJwt((v) => !v)}>
                    {showJwt ? "Hide JWT" : "Show JWT"}
                  </Button>
                  <Button
                    variant={userIdCopied ? "contained" : "outlined"}
                    onClick={() => copyWithFallback(userData.user.id, setUserIdCopied)}
                  >
                    {userIdCopied ? "Copied user ID" : "Copy user ID"}
                  </Button>
                  <Button
                    variant={jwtCopied ? "contained" : "outlined"}
                    onClick={() => copyWithFallback(userData.token, setJwtCopied)}
                    disabled={!userData.token}
                  >
                    {jwtCopied ? "Copied JWT" : "Copy JWT"}
                  </Button>
                </Box>

                {/* <TextField
                  variant="outlined"
                  margin="normal"
                  fullWidth
                  disabled
                  id="balance"
                  label="Cash Balance"
                  name="balance"
                  autoComplete="balance"
                  value={userData.user.balance}
                /> */}
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
                  type="password"
                  onChange={handleApiSecretKeyChange}

                  />
                <Typography component="p" variant="caption" align="center" sx={{ mt: 1 }}>
                  Current Alpaca keys: {alpacaKeysPresent ? `Set (${alpacaKeyIdMasked || "masked"})` : "Missing"}.
                  For security, the app does not display your secret key.
                </Typography>
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
    </Grid>
  );
};

export default SettingsModal;
