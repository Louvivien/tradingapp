import React from "react";
import { useNavigate } from "react-router-dom";

const NotFound = () => {
  const navigate = useNavigate();
  navigate("/");

  return <h1>Not Found!</h1>;
};

export default NotFound;
