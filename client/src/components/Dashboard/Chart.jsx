import React, { useState, useContext, useEffect } from "react";
import UserContext from "../../context/UserContext";
import Title from "../Template/Title.jsx";
import LineChart from "../Template/LineChartPort";
import axios from "axios";
import config from "../../config/Config";

const Chart = () => {
  const [chartData, setChartData] = useState(undefined);
  const { userData, setUserData } = useContext(UserContext);


  useEffect(() => {
    const headers = {
      "x-auth-token": userData.token,
    };

    const fetchPortfolioHistory = async () => {
      try {
        const response = await axios.get(
          `${config.base_url}/api/data/portfolio/${userData.user.id}`,
          { headers }
        );
        const portfolioData = response.data;
        // console.log("Chartdata:", portfolioData);

        setChartData(portfolioData);
      } catch (error) {
        // console.error("Error fetching portfolio history:", error);
      }
    };

    fetchPortfolioHistory();
  }, [userData.token, userData.user.id]);


  return chartData ? (
    <React.Fragment>
      <Title>Portfolio Performance Chart</Title>
      <div style={{ minHeight: "240px" }}>
        <LineChart pastDataPeriod={chartData.data} duration={"12 months"} />
      </div>
    </React.Fragment>
  ) : <></>
};

export default Chart;
