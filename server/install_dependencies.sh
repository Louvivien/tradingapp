#!/bin/bash

# install node modules
echo "Installing Node.js dependencies..."
yarn install

# navigate to scripts directory
cd scripts

# install python packages
echo "Installing Python dependencies..."
pip3 install -r requirements.txt

# navigate back to server directory
cd ..
