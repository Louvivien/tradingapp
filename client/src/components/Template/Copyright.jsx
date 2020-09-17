import React from "react";
import { Typography, Link } from "@material-ui/core/";

const Copyright = () => {
  return (
    <div>
      <Typography variant="body2" color="textSecondary" align="center">
        {"Copyright © "}
        <Link color="inherit" href="https://github.com/OktarianTB">
          Oktarian Tilney-Bassett
        </Link>{" "}
        {new Date().getFullYear()}
        {"."}
      </Typography>
      <br />
      <Typography variant="body2" color="textSecondary" align="center">
        This simulator is for entertainment & educational purposes only and uses
        fake money.
      </Typography>
      <Typography variant="body2" color="textSecondary" align="center">
        The simulator is not representative of real-world trading conditions and
        the data is not guaranteed to be accurate.
      </Typography>
    </div>
  );
};

export default Copyright;
