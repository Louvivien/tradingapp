import React from "react";
import { Line } from "react-chartjs-2";
import Chart from 'chart.js/auto';

const LineChartPort = ({ pastDataPeriod, stockInfo, duration, trendColors = false }) => {
  const formatDate = (date) => {
    var d = new Date(date),
      month = "" + (d.getMonth() + 1),
      day = "" + d.getDate();

    if (month.length < 2) month = "0" + month;
    if (day.length < 2) day = "0" + day;

    return [month, day].join("-");
  };

  // Check if we have valid portfolio history data
  const hasValidData = pastDataPeriod?.history?.length > 0;
  const history = hasValidData ? pastDataPeriod.history : [];
  const values = history.map(({ equity }) => equity);
  const baseLineColor = "rgba(0, 0, 255, 0.5)";
  const upColor = "rgba(46, 204, 113, 0.9)";
  const downColor = "rgba(231, 76, 60, 0.9)";

  const lineChart = hasValidData ? (
    <Line
      data={{
        labels: history.map(({ timestamp }) => formatDate(timestamp)),
        datasets: [
          {
            data: values,
            label: "Equity",
            borderColor: baseLineColor,
            fill: true,
            backgroundColor: "rgba(116, 185, 255, 0.2)",
            ...(trendColors
              ? {
                  segment: {
                    borderColor: (ctx) => {
                      const y0 = ctx?.p0?.parsed?.y;
                      const y1 = ctx?.p1?.parsed?.y;
                      if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
                        return baseLineColor;
                      }
                      return y1 >= y0 ? upColor : downColor;
                    },
                  },
                  pointBackgroundColor: (ctx) => {
                    const idx = ctx?.dataIndex ?? 0;
                    const current = values[idx];
                    const prev = idx > 0 ? values[idx - 1] : null;
                    if (!Number.isFinite(current) || prev === null || !Number.isFinite(prev)) {
                      return baseLineColor;
                    }
                    return current >= prev ? upColor : downColor;
                  },
                }
              : {}),
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
