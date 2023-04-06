import React, { useContext, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import UserContext from "../../context/UserContext";
import styles from "./PageTemplate.module.css";
import clsx from "clsx";
import {
  Drawer,
  CssBaseline,
  AppBar,
  Toolbar,
  List,
  Typography,
  Divider,
  IconButton,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import Navbar from "../Template/Navbar";
import SecondNavbar from "../Template/SecondNavbar";
import Dashboard from "../Dashboard/Dashboard";
import News from "../News/News";
import Search from "../Search/Search";
import SettingsModal from "./SettingsModal";
import Axios from "axios";
import { styled } from "@mui/material/styles";
import config from "../../config/Config";

const drawerWidth = 240;

const StyledAppBar = styled(AppBar)(({ theme, open }) => ({
  zIndex: theme.zIndex.drawer + 1,
  transition: theme.transitions.create(['width', 'margin'], {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  ...(open && {
    marginLeft: drawerWidth,
    width: `calc(100% - ${drawerWidth}px)`,
    transition: theme.transitions.create(['width', 'margin'], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
  }),
}));


const StyledDrawer = styled(Drawer)(({ theme, open }) => ({
  "& .MuiDrawer-paper": {
    position: "relative",
    whiteSpace: "nowrap",
    width: drawerWidth,
    transition: theme.transitions.create("width", {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
    overflowX: "hidden",
    boxSizing: "border-box",
    ...(open && {
      width: drawerWidth,
      transition: theme.transitions.create("width", {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.enteringScreen,
      }),
    }),
    ...(!open && {
      width: theme.spacing(7),
      transition: theme.transitions.create("width", {
        easing: theme.transitions.easing.sharp,
        duration: theme.transitions.duration.leavingScreen,
      }),
    }),
  },
}));



const PageTemplate = () => {
  const navigate = useNavigate();
  const { userData, setUserData } = useContext(UserContext);
  const [open, setOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState("dashboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [purchasedStocks, setPurchasedStocks] = useState([]);
  const [orderList, setOrderList] = useState([]);

  if (!userData.user) {
    navigate("/login");
  }

  const getPurchasedStocks = async () => {
    const url = config.base_url + `/api/stock/${userData.user.id}`;
    const headers = {
      "x-auth-token": userData.token,
    };

    const response = await Axios.get(url, {
      headers,
    });

    if (response.data.status === "success") {
      setPurchasedStocks(response.data.stocks);
    }
  };

  const getOrderList = async () => {
    const url = config.base_url + `/api/order/${userData.user.id}`;
    const headers = {
      "x-auth-token": userData.token,
    };

    const response = await Axios.get(url, {
      headers,
    });

    if (response.data.status === "success") {
      setOrderList(response.data.orders);
      console.log("response.data.orders ", response.data.orders);
      
    }
  };





  useEffect(() => {
 
    getPurchasedStocks();
  
  
    getOrderList();
  }, []);
  

  const logout = () => {
    setUserData({
      token: undefined,
      user: undefined,
    });
    localStorage.setItem("auth-token", "");
    navigate("/login");
  };

  const handleDrawerOpen = () => {
    setOpen(true);
  };

  const handleDrawerClose = () => {
    setOpen(false);
  };

  const openSettings = () => {
    setSettingsOpen(true);
  };

  return (
    <div className={styles.root}>
      <CssBaseline />
      <StyledAppBar
        position="absolute"
        open={open}
        className={clsx(styles.appBarBackground)}
      >
        <Toolbar className={styles.toolbar}>
          <IconButton
            edge="start"
            color="inherit"
            aria-label="open drawer"
            onClick={handleDrawerOpen}
            className={clsx(
              styles.menuButton,
              open && styles.menuButtonHidden
            )}
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
      </StyledAppBar>
      <StyledDrawer variant="permanent" open={open}>
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
    <SecondNavbar logout={logout} openSettings={openSettings} />
  </List>
</StyledDrawer>


      <main className={styles.content}>
        <div className={styles.appBarSpacer} />
        {currentPage === "dashboard" && (
          <Dashboard
            purchasedStocks={purchasedStocks}
            orderList={orderList}
          />
        )}
        {currentPage === "news" && <News />}
        {currentPage === "search" && (
          <Search
            setPurchasedStocks={setPurchasedStocks}
            purchasedStocks={purchasedStocks}
          />
        )}
        {settingsOpen && <SettingsModal setSettingsOpen={setSettingsOpen} />}
      </main>
    </div>
  );
  
};

export default PageTemplate;
