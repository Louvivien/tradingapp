import React from "react";
import { Typography, Link } from "@mui/material/";

const Copyright = () => {
  return (
    <div>
      <Typography variant="body2" color="textSecondary" align="center">
        {"Copyright © "}
        <Link color="inherit" href="https://github.com/Louvivien/tradingapp">
          AI Trading App
        </Link>{" "}
        {new Date().getFullYear()}
        {"."}
      </Typography>
      <br />
      <Typography variant="body2" color="textSecondary" align="center">
        
      </Typography>
      <Typography variant="body2" color="textSecondary" align="center">
        
      </Typography>
    </div>
  );
};

export default Copyright;
