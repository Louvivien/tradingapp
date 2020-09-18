import React, { useState, useEffect } from "react";
import Title from "../Template/Title.jsx";
import LineChart from "../Search/LineChart";
import Axios from "axios";

const Chart = () => {
  const [chartData, setChartData] = useState(undefined);

  useEffect(() => {
    const getData = async () => {
      const url = `http://127.0.0.1:5000/api/data/random`;
      const response = await Axios.get(url);
      if (response.data.status === "success") {
        setChartData(response.data);
      }
    };
    getData();
  }, []);

  return (
    <React.Fragment>
      {chartData && (
        <div style={{ minHeight: "240px" }}>
          <Title>Explore {chartData.name}'s stock chart</Title>
          <LineChart
            pastDataPeriod={chartData.data}
            stockInfo={{ ticker: chartData.ticker }}
            duration={"3 years"}
          />
        </div>
      )}
    </React.Fragment>
  );
};

export default Chart;
