import React from "react";
import ListItem from "@material-ui/core/ListItem";
import ListItemIcon from "@material-ui/core/ListItemIcon";
import ListItemText from "@material-ui/core/ListItemText";
import DashboardIcon from "@material-ui/icons/Dashboard";
import SearchIcon from "@material-ui/icons/Search";
import InfoIcon from "@material-ui/icons/Info";

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
