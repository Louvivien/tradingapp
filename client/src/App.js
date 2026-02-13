import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Route, Routes, useLocation, useParams } from "react-router-dom";
import styles from "./App.module.css";
import Test from "./components/Test/test";
import { Login, Register, NotFound, PageTemplate} from "./components";
import UserContext from "./context/UserContext";
import Axios from "axios";
import config from "./config/Config";

// Debug log for API base resolution
// eslint-disable-next-line no-console
console.log("[App] API base URL:", config.base_url);

const StrategyLogsRoute = () => {
  const { strategyId } = useParams();
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const strategyName = queryParams.get("name") || "";

  return (
    <PageTemplate
      initialPage="strategyLogs"
      initialStrategyId={strategyId}
      initialStrategyName={strategyName}
    />
  );
};



function App() {
  const loadStoredUser = () => {
    try {
      const raw = localStorage.getItem("user");
      if (!raw) {
        return undefined;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        return undefined;
      }
      // Never persist secrets in localStorage.
      delete parsed.ALPACA_API_KEY_ID;
      delete parsed.ALPACA_API_SECRET_KEY;
      delete parsed.ALPACA_LIVE_API_KEY_ID;
      delete parsed.ALPACA_LIVE_API_SECRET_KEY;
      return parsed;
    } catch {
      return undefined;
    }
  };

  const [userData, setUserData] = useState({
    token: localStorage.getItem("auth-token") || undefined,
    user: loadStoredUser(),
    ALPACA_API_KEY_ID: undefined,
    ALPACA_API_SECRET_KEY: undefined,
  });

  useEffect(() => {
    const checkLoggedIn = async () => {
      let token = localStorage.getItem("auth-token");
      if (token == null) {
        localStorage.setItem("auth-token", "");
        token = "";
        localStorage.removeItem("user");
        setUserData({ token: undefined, user: undefined, ALPACA_API_KEY_ID: undefined, ALPACA_API_SECRET_KEY: undefined });
        return;
      }

      const headers = {
        "x-auth-token": token,
      };

      const tokenIsValid = await Axios.post(
        config.base_url + "/api/auth/validate",
        null,
        {
          headers,
        }
      );

      if (tokenIsValid.data) {
        const userRes = await Axios.get(config.base_url + "/api/auth/user", {
          headers,
        });
        
        setUserData({
          token,
          user: userRes.data,
        });

        // Store user data in local storage
        localStorage.setItem("user", JSON.stringify(userRes.data));
      } else {
        localStorage.removeItem("user");
        setUserData({ token: undefined, user: undefined, ALPACA_API_KEY_ID: undefined, ALPACA_API_SECRET_KEY: undefined });
      }
    };

    checkLoggedIn();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const sendPing = () => {
      Axios.get(`${config.base_url}/api/ping`)
        .catch(() => {
          if (!cancelled) {
            // eslint-disable-next-line no-console
            console.warn("[KeepAlive] Failed to reach backend ping endpoint.");
          }
        });
    };

    sendPing();
    const intervalId = setInterval(sendPing, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return (
    <Router>
      <UserContext.Provider value={{ userData, setUserData }}>
        <div className={styles.container}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            {userData.user ? (
              <>
                <Route path="/" element={<PageTemplate />} />
                <Route path="/strategies/:strategyId/logs" element={<StrategyLogsRoute />} />
                <Route path="/logs" element={<PageTemplate initialPage="allLogs" />} />
                <Route path="/test" element={<Test />} />
              </>
            ) : (
              <Route path="/" element={<Register />} />
            )}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </UserContext.Provider>
    </Router>
  );
  
}

export default App;
