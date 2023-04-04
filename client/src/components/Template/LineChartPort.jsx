import React from "react";
import { Line } from "react-chartjs-2";
import Chart from 'chart.js/auto';

const LineChartPort = ({ pastDataPeriod, stockInfo, duration }) => {
  const formatDate = (date) => {
    var d = new Date(date),
      month = "" + (d.getMonth() + 1),
      day = "" + d.getDate();

    if (month.length < 2) month = "0" + month;
    if (day.length < 2) day = "0" + day;

    return [month, day].join("-");
  };

  const lineChart =
    pastDataPeriod.timestamp?.length > 0 ? (
      <Line
        data={{
          labels: pastDataPeriod.timestamp.map((timestamp) => formatDate(timestamp * 1000)),
          datasets: [
            {
              data: pastDataPeriod.equity,
              label: "Equity",
              borderColor: "rgba(0, 0, 255, 0.5)",
              fill: true,
              backgroundColor: "rgba(116, 185, 255, 0.2)",
            },
          ],
        }}
        options={{
          maintainAspectRatio: false,
          elements: {
            point: {
              radius: 2,
            },
          },
          legend: { display: false },
          layout: {
            padding: {
              left: 20,
              right: 20,
              top: 15,
              bottom: 0,
            },
          },
          title: {
            display: true,
            text: stockInfo
              ? `Adjusted closing stock price of ${stockInfo.ticker} over the past ${duration}`
              : `Portfolio Performance Chart over the past ${duration}`,
            position: "bottom",
          },
          animation: {
            duration: 2000,
          },
        }}
      />
    ) : null;

  return lineChart;
};

export default LineChartPort;
