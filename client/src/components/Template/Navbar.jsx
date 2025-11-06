import React from "react";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import DashboardIcon from "@mui/icons-material/Dashboard";
import SearchIcon from "@mui/icons-material/Search";
import InfoIcon from "@mui/icons-material/Info";
import PsychologyIcon from '@mui/icons-material/Psychology';


const Navbar = ({ currentPage, onNavigate }) => {
 
 
 
  const onNewsButtonClick = (e) => {
    e.preventDefault();
    onNavigate("news");
  };

  const onDashboardButtonClick = (e) => {
    e.preventDefault();
    onNavigate("dashboard");
  };

  const onStrategiesButtonClick = (e) => {
    e.preventDefault();
    onNavigate("strategies");
  };

  const onSearchButtonClick = (e) => {
    e.preventDefault();
    onNavigate("search");
  };

  return (
    <div>
      <ListItem
        button
        selected={currentPage === "dashboard"}
        onClick={onDashboardButtonClick}
      >
        <ListItemIcon>
          <DashboardIcon />
        </ListItemIcon>
        <ListItemText primary="Dashboard" />
      </ListItem>


      <ListItem
        button
        selected={currentPage === "search"}
        onClick={onSearchButtonClick}
      >
        <ListItemIcon>
          <SearchIcon />
        </ListItemIcon>
        <ListItemText primary="Search" />
      </ListItem>


      <ListItem
        button
        selected={currentPage === "strategies"}
        onClick={onStrategiesButtonClick}
      >
        <ListItemIcon>
          <PsychologyIcon />
        </ListItemIcon>
        <ListItemText primary="Strategies" />
      </ListItem>


      <ListItem
        button
        selected={currentPage === "news"}
        onClick={onNewsButtonClick}
      >
        <ListItemIcon>
          <InfoIcon />
        </ListItemIcon>
        <ListItemText primary="Market News" />
      </ListItem>
    </div>
  );
};

export default Navbar;
