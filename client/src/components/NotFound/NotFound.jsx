import React from "react";
import { useHistory } from "react-router-dom";

const NotFound = () => {
  const history = useHistory();
  history.push("/");

  return <h1>Not Found!</h1>;
};

export default NotFound;
