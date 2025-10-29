import React, { useState, useContext, useEffect } from "react";
import UserContext from "../../context/UserContext";
import Title from "../Template/Title.jsx";
import LineChart from "../Template/LineChartPort";
import axios from "axios";
import config from "../../config/Config";
import { logError, logWarn } from "../../utils/logger";

const Chart = () => {
  const [chartData, setChartData] = useState(null);
  const [error, setError] = useState(null);
  const { userData } = useContext(UserContext);


  useEffect(() => {
    const fetchPortfolioHistory = async () => {
      if (!userData?.token || !userData?.user?.id) {
        setChartData(null);
        return;
      }

      const headers = {
        "x-auth-token": userData.token,
      };

      try {
        const response = await axios.get(
          `${config.base_url}/api/data/portfolio/${userData.user.id}`,
          { headers }
        );

        if (response.data?.status !== "success" || !response.data?.portfolio) {
          logWarn("Portfolio history request did not succeed:", response.data);
          setChartData(null);
          setError(response.data?.message || "Unable to load portfolio history.");
          return;
        }

        const history = normalizePortfolioHistory(response.data.portfolio);

        if (!history || history.length === 0) {
          logWarn("Portfolio history response missing data:", response.data.portfolio);
          setChartData(null);
          setError("No portfolio history available.");
          return;
        }

        setChartData({ history });
        setError(null);
      } catch (fetchError) {
        logError("Error fetching portfolio history:", fetchError);
        setError(fetchError.response?.data?.message || fetchError.message);
        setChartData(null);
      }
    };

    fetchPortfolioHistory();
  }, [userData?.token, userData?.user?.id]);


  if (error) {
    return (
      <React.Fragment>
        <Title>Portfolio Performance Chart</Title>
        <div style={{ minHeight: "240px", display: "flex", alignItems: "center" }}>
          <p style={{ color: "#b00020" }}>{error}</p>
        </div>
      </React.Fragment>
    );
  }

  if (!chartData) {
    return null;
  }

  return (
    <React.Fragment>
      <Title>Portfolio Performance Chart</Title>
      <div style={{ minHeight: "240px" }}>
        <LineChart pastDataPeriod={chartData} duration={"12 months"} />
      </div>
    </React.Fragment>
  );
};

const normalizePortfolioHistory = (portfolio) => {
  if (!portfolio) {
    return null;
  }

  if (Array.isArray(portfolio.history)) {
    return portfolio.history;
  }

  const timestamps = portfolio.timestamp || portfolio.timestamps;
  const equities = portfolio.equity;

  if (!Array.isArray(timestamps) || !Array.isArray(equities) || timestamps.length !== equities.length) {
    return null;
  }

  return timestamps.map((ts, index) => ({
    timestamp: convertTimestamp(ts),
    equity: Number(equities[index]),
  }));
};

const convertTimestamp = (value) => {
  if (!value) {
    return value;
  }

  if (typeof value === "number") {
    return new Date(value * 1000).toISOString();
  }

  const parsed = Number(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed * 1000).toISOString();
  }

  return value;
};

export default Chart;
