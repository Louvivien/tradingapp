import React, { useContext } from "react";
import { useHistory } from "react-router-dom";
import UserContext from "../../context/UserContext";
import styles from "./Dashboard.module.css";

const Dashboard = () => {
  const history = useHistory();
  const { userData, setUserData } = useContext(UserContext);

  if (!userData.user) {
    console.log(userData);
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

  return (
    <div className={styles.container}>
      <h1>Dashboard</h1>
      <h3>Welcome {userData.user.username}</h3>
      <button onClick={logout}>Log Out</button>
    </div>
  );
};

export default Dashboard;
