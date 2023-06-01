#!/bin/bash

# exit on error
set -o errexit

STORAGE_DIR=/opt/render/project/.render

if [[ ! -d $STORAGE_DIR/chrome ]]; then
  echo "...Downloading Chrome"
  mkdir -p $STORAGE_DIR/chrome
  cd $STORAGE_DIR/chrome
  wget -P ./ https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  dpkg -x ./google-chrome-stable_current_amd64.deb $STORAGE_DIR/chrome
  rm ./google-chrome-stable_current_amd64.deb
  cd $HOME/project/src # Make sure we return to where we were
else
  echo "...Using Chrome from cache"
fi

# be sure to add Chromes location to the PATH as part of your Start Command
# export PATH="${PATH}:/opt/render/project/.render/chrome/opt/google/chrome"

# install node modules
echo "Installing Node.js dependencies..."
yarn install

# navigate to scripts directory
cd scripts

# upgrade pip in the virtual environment
echo "Upgrading pip in the virtual environment..."
/opt/render/project/src/.venv/bin/python -m pip install --upgrade pip

# install python packages
echo "Installing Python dependencies..."
pip3 install -r requirements.txt

# navigate back to server directory
cd ..
