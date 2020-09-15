import React, { useContext, useState } from "react";
import { useHistory } from "react-router-dom";
import UserContext from "../../context/UserContext";
import styles from "../Dashboard/Dashboard.module.css";
import clsx from "clsx";
import useStyles from "./styles";
import {
  Drawer,
  CssBaseline,
  AppBar,
  Toolbar,
  List,
  Typography,
  Divider,
  IconButton,
} from "@material-ui/core";
import MenuIcon from "@material-ui/icons/Menu";
import ChevronLeftIcon from "@material-ui/icons/ChevronLeft";
import Navbar from "../Template/Navbar";
import SecondNavbar from "../Template/SecondNavbar";
import Dashboard from "../Dashboard/Dashboard";
import News from "../News/News";
import Search from "../Search/Search";

const PageTemplate = () => {
  const history = useHistory();
  const classes = useStyles();
  const { userData, setUserData } = useContext(UserContext);
  const [open, setOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState("dashboard");

  if (!userData.user) {
    history.push("/login");
  }

  const logout = () => {
    setUserData({
      token: undefined,
      user: undefined,
    });
    localStorage.setItem("auth-token", "");
    history.push("/login");
  };

  const handleDrawerOpen = () => {
    setOpen(true);
  };

  const handleDrawerClose = () => {
    setOpen(false);
  };

  return (
    <div className={styles.root}>
      <CssBaseline />
      <AppBar
        position="absolute"
        className={clsx(
          styles.appBarBackground,
          classes.appBar,
          open && classes.appBarShift
        )}
      >
        <Toolbar className={styles.toolbar}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open drawer"
            onClick={handleDrawerOpen}
            className={clsx(styles.menuButton, open && styles.menuButtonHidden)}
          >
            <MenuIcon />
          </IconButton>
          <Typography
            component="h1"
            variant="h6"
            color="inherit"
            noWrap
            className={styles.title}
          >
            {currentPage === "dashboard" && "Dashboard"}
            {currentPage === "news" && "Market News"}
            {currentPage === "search" && "Search"}
          </Typography>
          <Typography color="inherit">
            Hello,{" "}
            {userData.user.username
              ? userData.user.username.charAt(0).toUpperCase() +
                userData.user.username.slice(1)
              : ""}
          </Typography>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        classes={{
          paper: clsx(classes.drawerPaper, !open && classes.drawerPaperClose),
        }}
        open={open}
      >
        <div className={styles.toolbarIcon}>
          <IconButton onClick={handleDrawerClose}>
            <ChevronLeftIcon />
          </IconButton>
        </div>
        <Divider />
        <List>
          <Navbar currentPage={currentPage} setCurrentPage={setCurrentPage} />
        </List>
        <Divider />
        <List>
          <SecondNavbar logout={logout} />
        </List>
      </Drawer>
      <main className={styles.content}>
        <div className={classes.appBarSpacer} />
        {currentPage === "dashboard" && <Dashboard />}
        {currentPage === "news" && <News />}
        {currentPage === "search" && <Search />}
      </main>
    </div>
  );
};

export default PageTemplate;
