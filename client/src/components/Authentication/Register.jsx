import React, { useState } from "react";
import {
  Box,
  Typography,
  TextField,
  CssBaseline,
  Button,
  Card,
  CardContent,
  Grid,
  Link,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import Axios from "axios";
import config from "../../config/Config";
import styles from "./Auth.module.css";

const Register = () => {
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [usernameError, setUsernameError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [loading, setLoading] = useState(false);

  const onChangeUsername = (e) => {
    const newUsername = e.target.value;
    setUsername(newUsername);

    if (newUsername.length < 4 || newUsername.length > 30) {
      setUsernameError("Username must be between 4 and 30 characters. It can be an email address.");
    } else {
      setUsernameError("");
    }
  };

  const onChangePassword = (e) => {
    const newPassword = e.target.value;
    setPassword(newPassword);

    if (newPassword.length < 6 || newPassword.length > 20) {
      setPasswordError("Password must be between 6 and 20 characters.");
    } else {
      setPasswordError("");
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    if (!usernameError && !passwordError) {
      const newUser = { username, password };
      const url = config.base_url + "/api/auth/register";
      try {
        const registerRes = await Axios.post(url, newUser);
        if (registerRes.data.status === "fail") {
          if (!registerRes.data.type) {
            setPasswordError(registerRes.data.message);
            setUsernameError(registerRes.data.message);
          } else if (registerRes.data.type === "username") {
            setUsernameError(registerRes.data.message);
          } else if (registerRes.data.type === "password") {
            setPasswordError(registerRes.data.message);
          }
        } else {
          navigate("/login");
        }
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  };

  return (
    <div className={styles.background}>
      <CssBaseline />
      <Grid
        spacing={0}
        direction="column"
        alignItems="center"
        justify="center"
      >
        <Grid item xs={12} sm={8} md={6} lg={4}>
          <Box boxShadow={1}>
            <Card className={styles.paper}>
              <CardContent>
                <Typography component="h1" variant="h5">
                  Register
                </Typography>
                <form className={styles.form} onSubmit={onSubmit}>
                  <TextField
                    variant="outlined"
                    margin="normal"
                    required
                    fullWidth
                    id="username"
                    label="Username"
                    name="username"
                    autoComplete="username"
                    error={usernameError.length > 0 ? true : false}
                    helperText={usernameError}
                    value={username}
                    onChange={onChangeUsername}
                  />
                  <TextField
                    variant="outlined"
                    margin="normal"
                    required
                    fullWidth
                    name="password"
                    label="Password"
                    type="password"
                    id="password"
                    autoComplete="current-password"
                    error={passwordError.length > 0 ? true : false}
                    helperText={passwordError}
                    value={password}
                    onChange={onChangePassword}
                  />
                  <Box display="flex" justifyContent="center">
                    {loading ? (
                      <Typography variant="body1">Registering...</Typography>
                    ) : (
                      <Button
                        type="submit"
                        variant="contained"
                        color="primary"
                        className={styles.submit}
                      >
                        Register
                      </Button>
                    )}
                  </Box>
                </form>
                <Grid container justify="center">
                  <Grid item>
                    <Link href="/login" variant="body2">
                      Already have an account?
                    </Link>
                  </Grid>
                </Grid>
              </CardContent>
            </Card>
          </Box>
        </Grid>
      </Grid>
    </div>
  );
};

export default Register;
