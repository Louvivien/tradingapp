import React, { useContext, useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
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
import Strategies from "../Strategies/Strategies";
import StrategyLogs from "../Strategies/StrategyLogs";
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



const PageTemplate = ({ initialPage = "dashboard", initialStrategyId = null, initialStrategyName = "" }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { userData, setUserData } = useContext(UserContext);
  const [open, setOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(initialPage || "dashboard");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [purchasedStocks, setPurchasedStocks] = useState([]);
  const [accountBalance, setAccountBalance] = useState([]);
  const [selectedStrategyForLogs, setSelectedStrategyForLogs] = useState({
    id: initialStrategyId,
    name: initialStrategyName,
  });



  //Function to get the list of purchased stocks from the server using Alpacas API
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
      // console.log("response.data.stocks ", response.data.stocks);
      setAccountBalance(response.data.cash);
    }
  };


  useEffect(() => {
    getPurchasedStocks();
  }, []);

  useEffect(() => {
    setSelectedStrategyForLogs({
      id: initialStrategyId,
      name: initialStrategyName,
    });
  }, [initialStrategyId, initialStrategyName]);

  useEffect(() => {
    setCurrentPage(initialPage || "dashboard");
  }, [initialPage]);

  useEffect(() => {
    const isStrategyLogsRoute = /^\/strategies\/[^/]+\/logs/.test(location.pathname);
    if (isStrategyLogsRoute) {
      if (currentPage !== "strategyLogs") {
        setCurrentPage("strategyLogs");
      }
    } else if (currentPage === "strategyLogs") {
      setCurrentPage("dashboard");
      setSelectedStrategyForLogs({
        id: null,
        name: "",
      });
    }
  }, [location.pathname, currentPage]);


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

  const handleCloseStrategyLogs = () => {
    setSelectedStrategyForLogs({
      id: null,
      name: "",
    });
    setCurrentPage("dashboard");
    navigate("/");
  };

  const handleViewStrategyLogs = ({ id, name }) => {
    if (!id) {
      return;
    }
    setSelectedStrategyForLogs({
      id,
      name: name || "",
    });
    setCurrentPage("strategyLogs");
    navigate(`/strategies/${id}/logs?name=${encodeURIComponent(name || "")}`);
  };

  // console.log("userData.user ", userData.user);

  if (!userData.user) {
    navigate("/login");
  }



  return (
    <div className={styles.root}>
      <CssBaseline />
      <StyledAppBar
        position="fixed"
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
            {currentPage === "strategies" && "Strategies"}
            {currentPage === "strategyLogs" && "Strategy Logs"}
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

          //we pass the data to the Dashboard component
          <Dashboard
            userData={userData}
            setUserData={setUserData}
            onViewStrategyLogs={handleViewStrategyLogs}
          />



        )}

        {currentPage === "news" && <News />}
        {currentPage === "strategies" && <Strategies />}
        {currentPage === "strategyLogs" && (
          <StrategyLogs
            strategyId={selectedStrategyForLogs.id}
            strategyName={selectedStrategyForLogs.name}
            onClose={handleCloseStrategyLogs}
          />
        )}
        {currentPage === "search" && (


          <Search
            setPurchasedStocks={setPurchasedStocks}
            purchasedStocks={purchasedStocks}
            accountBalance={accountBalance}
          />


        )}
        {settingsOpen && <SettingsModal setSettingsOpen={setSettingsOpen} />}
      </main>
    </div>
  );

};

export default PageTemplate;
