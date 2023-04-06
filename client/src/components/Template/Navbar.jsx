import React from "react";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import DashboardIcon from "@mui/icons-material/Dashboard";
import SearchIcon from "@mui/icons-material/Search";
import InfoIcon from "@mui/icons-material/Info";

const Navbar = ({ currentPage, setCurrentPage }) => {
  const onNewsButtonClick = (e) => {
    e.preventDefault();
    setCurrentPage("news");
  };

  const onDashboardButtonClick = (e) => {
    e.preventDefault();
    setCurrentPage("dashboard");
  };

  const onSearchButtonClick = (e) => {
    e.preventDefault();
    setCurrentPage("search");
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
