import React, { useState, useEffect } from "react";
import { Line } from "react-chartjs-2";

const StockChart = () => {
  const [weeklyData, setWeeklyData] = useState([]);

  useEffect(() => {
    setWeeklyData([
      {
        date: "2020-09-08T00:00:00.000Z",
        close: 112.82,
        high: 118.99,
        low: 112.68,
        open: 113.95,
        volume: 231366563,
        adjClose: 112.82,
        adjHigh: 118.99,
        adjLow: 112.68,
        adjOpen: 113.95,
        adjVolume: 231366563,
        divCash: 0,
        splitFactor: 1,
      },
      {
        date: "2020-09-09T00:00:00.000Z",
        close: 117.32,
        high: 119.14,
        low: 115.26,
        open: 117.26,
        volume: 176940455,
        adjClose: 117.32,
        adjHigh: 119.14,
        adjLow: 115.26,
        adjOpen: 117.26,
        adjVolume: 176940455,
        divCash: 0,
        splitFactor: 1,
      },
      {
        date: "2020-09-10T00:00:00.000Z",
        close: 113.49,
        high: 120.5,
        low: 112.5,
        open: 120.36,
        volume: 182274391,
        adjClose: 113.49,
        adjHigh: 120.5,
        adjLow: 112.5,
        adjOpen: 120.36,
        adjVolume: 182274391,
        divCash: 0,
        splitFactor: 1,
      },
      {
        date: "2020-09-11T00:00:00.000Z",
        close: 112,
        high: 115.23,
        low: 110,
        open: 114.57,
        volume: 180860325,
        adjClose: 112,
        adjHigh: 115.23,
        adjLow: 110,
        adjOpen: 114.57,
        adjVolume: 180860325,
        divCash: 0,
        splitFactor: 1,
      },
      {
        date: "2020-09-14T00:00:00.000Z",
        close: 115.355,
        high: 115.93,
        low: 112.8,
        open: 114.72,
        volume: 140150087,
        adjClose: 115.355,
        adjHigh: 115.93,
        adjLow: 112.8,
        adjOpen: 114.72,
        adjVolume: 140150087,
        divCash: 0,
        splitFactor: 1,
      },
    ]);
  }, []);

  const formatDate = (date) => {
    var d = new Date(date),
      month = "" + (d.getMonth() + 1),
      day = "" + d.getDate(),
      year = d.getFullYear();

    if (month.length < 2) month = "0" + month;
    if (day.length < 2) day = "0" + day;

    return [year, month, day].join("-");
  };

  const lineChart =
    weeklyData.length > 0 ? (
      <Line
        data={{
          labels: weeklyData.map(({ date }) => formatDate(date)),
          datasets: [
            {
              data: weeklyData.map(({ close }) => close),
              label: "Price",
              borderColor: "rgba(0, 0, 255, 0.5)",
              fill: true,
              backgroundColor: "rgba(116, 185, 255, 0.2)",
            },
          ],
        }}
        options={{
          maintainAspectRatio: false,
          scales: {
            yAxes: [
              {
                ticks: {
                  beginAtZero: true,
                },
              },
            ],
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
            text: "Stock Price of AMZN",
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

export default StockChart;
