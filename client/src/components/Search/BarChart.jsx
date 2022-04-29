import React from "react";
import { Bar } from "react-chartjs-2";
import Chart from 'chart.js/auto';

const BarChart = ({ sixMonthAverages, stockInfo }) => {
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "June",
    "July",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const barChart = sixMonthAverages ? (
    <Bar
      data={{
        labels: sixMonthAverages.map(({ month }) => monthNames[month]),
        datasets: [
          {
            label: "Price",
            backgroundColor: "rgba(0, 0, 255, 0.3)",
            data: sixMonthAverages.map(({ value }) => value),
          },
        ],
      }}
      options={{
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
          }
        },
        legend: { display: false },
        layout: {
          padding: {
            left: 10,
            right: 10,
            top: 15,
            bottom: 0,
          },
        },
        title: {
          display: true,
          text: `Average closing price per month of ${stockInfo.ticker} over the past 6 months`,
          position: "bottom",
        },
        animation: {
          duration: 2000,
        },
      }}
    />
  ) : null;

  return barChart;
};

export default BarChart;
